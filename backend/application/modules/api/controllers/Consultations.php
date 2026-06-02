<?php
defined('BASEPATH') OR exit('No direct script access allowed');

require_once APPPATH . 'modules/api/controllers/Api_base.php';

class Consultations extends Api_base {

    public function index() {
        $this->require_auth();

        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        $today = date('Y-m-d');

        // Antrian PST: HANYA 4 layanan inti SKD (Perpustakaan, Konsultasi Statistik,
        // Rekomendasi, Penjualan). DTSEN punya antrian sendiri di /api/dtsen.
        // Resepsionis (Lainnya, Keperluan Pimpinan) tidak masuk antrian — di-handle
        // langsung di Daftar Kunjungan (/api/visits) tanpa flow antrian.
        // jenis_layanan disimpan sebagai JSON array string ('["Perpustakaan"]') — pakai LIKE
        // OR untuk match salah satu nama; karena grup mutually exclusive, sebuah visit
        // dengan layanan SKD pasti hanya berisi item-item SKD.
        $consultations = $this->db
            ->select('k.*, b.nama, b.nama_instansi, b.email, b.notel, b.jeniskelamin, b.pendidikan, b.pekerjaan, b.kategori_instansi')
            // has_konsultasi: jumlah baris kebutuhan_data NYATA (rincian terisi).
            // FE pakai ini untuk bedakan tombol "Mulai" vs "Lihat/Edit". Filter
            // rincian_data non-NULL/non-kosong supaya "ghost row" ringkasan
            // (rincian NULL via Visits::summary) tidak ke-hitung sebagai data SKD.
            // Arg kedua FALSE => CI3 tidak backtick-escape subquery-nya.
            ->select("(SELECT COUNT(*) FROM konsultasi_pengunjung kp WHERE kp.id_kunjungan = k.id_kunjungan AND kp.rincian_data IS NOT NULL AND TRIM(kp.rincian_data) <> '') AS has_konsultasi", FALSE)
            ->from('tamdes_kunjungan k')
            ->join('tamdes_buku b', 'k.id_user = b.id_user', 'left')
            ->where("DATE(k.date_visit)", $today)
            ->group_start()
                ->like('k.jenis_layanan', 'Perpustakaan')
                ->or_like('k.jenis_layanan', 'Konsultasi Statistik')
                ->or_like('k.jenis_layanan', 'Rekomendasi Kegiatan Statistik')
                ->or_like('k.jenis_layanan', 'Penjualan Produk Statistik')
            ->group_end()
            ->where("(k.created_by IS NULL OR k.created_by <> 'whatsapp')", NULL, FALSE)   // WA visits live in Layanan Online inbox, not the PST queue
            ->order_by('k.date_visit', 'DESC')
            ->get()->result();

        $this->json_response(['success' => true, 'data' => $consultations, 'message' => 'OK']);
    }

    public function detail($id) {
        $this->require_auth();

        if ($_SERVER['REQUEST_METHOD'] !== 'PUT') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        $input  = $this->get_json_input();
        $status = $input['status'] ?? null;

        if (!$status) {
            $this->json_response(['success' => false, 'message' => 'status diperlukan'], 400);
        }
        if (!in_array($status, $this->valid_statuses(), true)) {
            $this->json_response(['success' => false, 'message' => 'Status tidak valid'], 400);
        }

        $visit = $this->db->get_where('tamdes_kunjungan', ['id_kunjungan' => $id])->row();
        if (!$visit) {
            $this->json_response(['success' => false, 'message' => 'Kunjungan tidak ditemukan'], 404);
        }

        // Gate: hanya transisi finalisasi (selesai/menunggu_evaluasi) yang dicek per layanan.
        // Status awal (dipanggil/diproses) bebas — semua role boleh memanggil & mulai.
        if (in_array($status, ['selesai', 'menunggu_evaluasi'], true)) {
            $this->require_layanan_role($visit->jenis_layanan);
        }

        // Soft-correct: kalau layanan SKD (perlu evaluasi) tapi FE kirim 'selesai' langsung,
        // koreksi ke 'menunggu_evaluasi'. Bypass roles boleh override (admin/superadmin/operator).
        if ($status === 'selesai') {
            $role = isset($this->current_user->role) ? $this->current_user->role : 'operator';
            $is_bypass = in_array($role, ['admin', 'superadmin', 'operator'], true);
            if (!$is_bypass && $this->next_status_after_completion($visit->jenis_layanan) === 'menunggu_evaluasi') {
                $status = 'menunggu_evaluasi';
            }
        }

        // ── Form-complete gates (defense-in-depth dengan endpoint /api/visits/{id}/status) ──
        // Cermin gate Visits::status untuk endpoint /api/consultations/{id} yang juga bisa transisi finalisasi.
        // Kalau gate ini lolos di Visits tapi user pakai Consultations endpoint, harus reject sama.
        if (in_array($status, ['selesai', 'menunggu_evaluasi'], true)) {
            // Gate 1: keterangan wajib untuk Lainnya / Keperluan Pimpinan (resepsionis path).
            if ($this->layanan_requires_keterangan($visit->jenis_layanan)) {
                $konsul     = $this->db->get_where('konsultasi_pengunjung', ['id_kunjungan' => $id])->row();
                $keterangan = $konsul ? trim((string) $konsul->hasil_konsultasi) : '';
                if ($keterangan === '') {
                    $this->json_response([
                        'success' => false,
                        'message' => 'Keterangan wajib diisi sebelum visit ini bisa diselesaikan. Isi field "Ringkasan / Keterangan" terlebih dahulu.',
                    ], 400);
                }
            }
            // Gate 2: form SKD (kebutuhan_data) wajib ≥1 baris untuk 4 layanan inti SKD.
            if ($this->layanan_requires_skd_form($visit->jenis_layanan)) {
                $cnt = (int) $this->db->where('id_kunjungan', $id)->count_all_results('konsultasi_pengunjung');
                if ($cnt === 0) {
                    $this->json_response([
                        'success' => false,
                        'message' => 'Form konsultasi SKD belum lengkap. Isi minimal 1 baris kebutuhan data + ringkasan konsultasi sebelum menyelesaikan visit.',
                    ], 400);
                }
            }
        }

        $update = ['status' => $status];

        if ($status === 'selesai') {
            $selesai_timestamp           = date('Y-m-d H:i:s');
            $update['selesai_timestamp'] = $selesai_timestamp;
            if ($visit->date_visit) {
                $durasi                  = strtotime($selesai_timestamp) - strtotime($visit->date_visit);
                $update['durasi_detik']  = max(0, $durasi);
            }
        }

        $this->db->where('id_kunjungan', $id)->update('tamdes_kunjungan', $update);
        $updated = $this->db->get_where('tamdes_kunjungan', ['id_kunjungan' => $id])->row();

        $this->json_response(['success' => true, 'data' => $updated, 'message' => 'Status berhasil diupdate']);
    }

    public function call($id) {
        $this->require_auth();

        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        $visit = $this->db->select('nomor_antrian, status')
                          ->get_where('tamdes_kunjungan', ['id_kunjungan' => $id])
                          ->row();

        if (!$visit) {
            $this->json_response(['success' => false, 'message' => 'Kunjungan tidak ditemukan'], 404);
        }

        if (!$visit->nomor_antrian) {
            $this->json_response(['success' => false, 'message' => 'Visit ini tidak punya nomor antrian'], 400);
        }

        $nomor  = $visit->nomor_antrian;
        $result = $this->proxy_antrian($nomor);

        // Strict mode: kalau dashboard PST tidak menerima panggilan, JANGAN update DB.
        // Status DB harus selalu reflect kondisi dashboard sebenarnya — kolom `status`
        // di-reference oleh evaluasi PST + audit log, jadi tidak boleh corrupt.
        if (!$result['success']) {
            $this->audit('call_queue_failed', 'visit', $id, [
                'nomor'     => $nomor,
                'reason'    => $result['message']  ?? 'unknown',
                'http_code' => $result['http_code'] ?? null,
            ]);
            $this->json_response([
                'success' => false,
                'message' => 'Dashboard antrian tidak merespons. Status tidak diubah. ' .
                             'Detail: ' . ($result['message'] ?? 'unknown error'),
            ], 502);
        }

        // Auto-transition antri → dipanggil. Tidak men-downgrade status yang sudah lebih lanjut.
        if ($visit->status === 'antri') {
            $this->db->where('id_kunjungan', $id)->update('tamdes_kunjungan', ['status' => 'dipanggil']);
            $this->audit('call_queue', 'visit', $id, ['nomor' => $nomor, 'status_to' => 'dipanggil']);
        }

        $this->json_response($result);
    }

    public function test_sound($id) {
        $this->require_auth();

        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        $result = $this->proxy_antrian('TES');

        $this->json_response($result);
    }

    public function data($id) {
        $this->require_auth();

        if ($_SERVER['REQUEST_METHOD'] === 'GET') {
            // Authz: samakan dengan POST — petugas hanya boleh baca data konsultasi
            // visit yang sesuai grup layanannya (admin/superadmin/operator bypass via
            // helper). Tanpa ini GET hanya require_auth() → IDOR: user mana pun bisa
            // enumerasi id & baca rincian/hasil_konsultasi lintas-scope.
            $visit_check = $this->db->select('jenis_layanan')->get_where('tamdes_kunjungan', ['id_kunjungan' => $id])->row();
            if (!$visit_check) {
                $this->json_response(['success' => false, 'message' => 'Kunjungan tidak ditemukan'], 404);
            }
            $this->require_layanan_role($visit_check->jenis_layanan);

            $rows = $this->db->get_where('konsultasi_pengunjung', ['id_kunjungan' => $id])->result();
            $this->json_response(['success' => true, 'data' => $rows, 'message' => 'OK']);

        } elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
            // Gate: simpan data konsultasi = penyelesaian layanan, harus sesuai role.
            $visit_check = $this->db->select('jenis_layanan')->get_where('tamdes_kunjungan', ['id_kunjungan' => $id])->row();
            if (!$visit_check) {
                $this->json_response(['success' => false, 'message' => 'Kunjungan tidak ditemukan'], 404);
            }
            $this->require_layanan_role($visit_check->jenis_layanan);

            $input            = $this->get_json_input();
            $hasil_konsultasi = trim((string) ($input['hasil_konsultasi'] ?? ''));
            $kebutuhan_data   = $input['kebutuhan_data'] ?? [];

            // Form-lengkap gate: wajib ≥1 baris kebutuhan_data dengan rincian_data terisi
            // + hasil_konsultasi (ringkasan) non-empty. Ringkasan harus diisi sebagai
            // catatan apa yang dibahas — bukan harus hasil data yang sudah diperoleh.
            // Untuk kasus "data belum diperoleh", petugas tulis: "Permintaan X akan dikirim
            // via email setelah data tersedia" — itu sudah sah sebagai ringkasan konsultasi.
            if (!is_array($kebutuhan_data) || count($kebutuhan_data) === 0) {
                $this->json_response([
                    'success' => false,
                    'message' => 'Minimal 1 baris kebutuhan data wajib diisi sebelum simpan.',
                ], 400);
            }
            $valid_rows = 0;
            foreach ($kebutuhan_data as $r) {
                $rincian = trim((string)($r['rincian_data'] ?? ''));
                if ($rincian !== '') $valid_rows++;
            }
            if ($valid_rows === 0) {
                $this->json_response([
                    'success' => false,
                    'message' => 'Minimal 1 baris kebutuhan data harus berisi "rincian data" yang diminta tamu.',
                ], 400);
            }
            if ($hasil_konsultasi === '') {
                $this->json_response([
                    'success' => false,
                    'message' => 'Ringkasan / hasil konsultasi wajib diisi sebelum simpan.',
                ], 400);
            }

            // Atomik: delete + reinsert + transisi status dibungkus satu transaksi.
            // Tanpa ini, kalau sebuah insert gagal di tengah loop, baris lama sudah
            // ke-DELETE (autocommit) → data konsultasi hilang permanen sementara
            // endpoint tetap balas 200 success. Transaksi memastikan all-or-nothing.
            $this->db->trans_start();

            // Delete existing rows for this visit
            $this->db->where('id_kunjungan', $id)->delete('konsultasi_pengunjung');

            // Insert new rows
            $now = date('Y-m-d H:i:s');
            foreach ($kebutuhan_data as $item) {
                $row = [
                    'id_kunjungan'       => $id,
                    'hasil_konsultasi'   => $hasil_konsultasi,
                    'rincian_data'       => $item['rincian_data'] ?? null,
                    'wilayah_data'       => $item['wilayah_data'] ?? null,
                    'tahun_awal'         => $item['tahun_awal'] ?? null,
                    'tahun_akhir'        => $item['tahun_akhir'] ?? null,
                    'level_data'         => $item['level_data'] ?? null,
                    'periode_data'       => $item['periode_data'] ?? null,
                    'status_data'        => $item['status_data'] ?? null,
                    'jenis_publikasi'    => $item['jenis_publikasi'] ?? null,
                    'judul_publikasi'    => $item['judul_publikasi'] ?? null,
                    'tahun_publikasi'    => $item['tahun_publikasi'] ?? null,
                    'digunakan_nasional' => $item['digunakan_nasional'] ?? null,
                    'kualitas'           => $item['kualitas'] ?? null,
                    'tanggal_input'      => $now,
                ];
                $this->db->insert('konsultasi_pengunjung', $row);
            }

            // Auto-transition: setelah operator simpan data, lanjutkan visit.
            // Tujuan tergantung jenis layanan: PST → menunggu_evaluasi, resepsionis → langsung selesai.
            // Skip kalau visit sudah dilanjut ke menunggu_evaluasi/selesai (idempoten).
            // Update status ikut DI DALAM transaksi supaya konsisten dengan datanya.
            $visit = $this->db->select('status, jenis_layanan, date_visit')
                              ->get_where('tamdes_kunjungan', ['id_kunjungan' => $id])->row();
            $status_from = null;
            $status_to   = null;
            if ($visit && $visit->status !== 'selesai' && $visit->status !== 'menunggu_evaluasi') {
                $next_status = $this->next_status_after_completion($visit->jenis_layanan);
                $update = ['status' => $next_status];
                if ($next_status === 'selesai') {
                    $selesai_ts = date('Y-m-d H:i:s');
                    $update['selesai_timestamp'] = $selesai_ts;
                    if ($visit->date_visit) {
                        $update['durasi_detik'] = max(0, strtotime($selesai_ts) - strtotime($visit->date_visit));
                    }
                }
                $this->db->where('id_kunjungan', $id)->update('tamdes_kunjungan', $update);
                $status_from = $visit->status;
                $status_to   = $next_status;
            }

            $this->db->trans_complete();

            if ($this->db->trans_status() === FALSE) {
                $this->json_response([
                    'success' => false,
                    'message' => 'Gagal menyimpan data konsultasi (transaksi dibatalkan). Silakan coba lagi.',
                ], 500);
            }

            // Audit hanya setelah commit sukses — jangan log save yang ter-rollback.
            if ($status_to !== null) {
                $this->audit('save_consultation', 'visit', $id, ['status_from' => $status_from, 'status_to' => $status_to]);
            }

            $saved = $this->db->get_where('konsultasi_pengunjung', ['id_kunjungan' => $id])->result();
            if (empty($saved)) {
                // Jaring kedua: commit "sukses" tapi 0 baris tersimpan → jangan
                // balas success (FE akan toast sukses + navigate, menyesatkan).
                $this->json_response([
                    'success' => false,
                    'message' => 'Gagal menyimpan data konsultasi (tidak ada baris tersimpan). Silakan coba lagi.',
                ], 500);
            }

            $this->json_response(['success' => true, 'data' => $saved, 'message' => 'Data konsultasi berhasil disimpan']);
        } else {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }
    }

    private function proxy_antrian($nomor) {
        $url     = $this->_env('DASHBOARD_PST_URL', 'https://dashboard-pst.bpsmalut.com/api/update-antrian');
        $payload = json_encode(['nomor' => $nomor]);

        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
        curl_setopt($ch, CURLOPT_TIMEOUT, 10);

        $response  = curl_exec($ch);
        $http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error     = curl_error($ch);
        curl_close($ch);

        if ($error) {
            return ['success' => false, 'message' => 'cURL error: ' . $error];
        }

        if ($http_code >= 200 && $http_code < 300) {
            return ['success' => true, 'message' => 'Antrian berhasil dipanggil', 'nomor' => $nomor];
        }

        return ['success' => false, 'message' => 'Gagal memanggil antrian', 'http_code' => $http_code];
    }
}
