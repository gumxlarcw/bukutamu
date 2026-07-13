<?php
defined('BASEPATH') OR exit('No direct script access allowed');

require_once APPPATH . 'modules/api/controllers/Api_base.php';

/**
 * Antrian Konsultasi DTSEN (Data Terpadu Sosial Ekonomi Nasional).
 * Alur terpisah dari Konsultasi SKD: form data berbeda (tabel dtsen_konsultasi),
 * tidak ada evaluasi tablet (next_status → 'selesai' langsung).
 */
class Dtsen extends Api_base {

    public function index() {
        $this->require_auth();

        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        $today = date('Y-m-d');

        // Hanya visit hari ini dengan layanan Konsultasi DTSEN.
        $visits = $this->db
            ->select('k.*, b.nama, b.nama_instansi, b.email, b.notel, b.jeniskelamin, b.pendidikan, b.pekerjaan, b.kategori_instansi')
            // has_konsultasi: ada-tidaknya baris dtsen_konsultasi (parity dgn SKD).
            // Tabel ini hanya berisi 0/1 baris per visit & 'catatan' wajib saat
            // simpan, jadi COUNT(*)>0 = sudah disimpan. FE -> tombol "Lihat/Edit".
            // Arg kedua FALSE => CI3 tidak backtick-escape subquery.
            ->select("(SELECT COUNT(*) FROM dtsen_konsultasi dk WHERE dk.id_kunjungan = k.id_kunjungan) AS has_konsultasi", FALSE)
            ->from('tamdes_kunjungan k')
            ->join('tamdes_buku b', 'k.id_user = b.id_user', 'left')
            ->where("DATE(k.date_visit)", $today)
            ->where("k.jenis_layanan LIKE", '%Konsultasi DTSEN%')
            ->where("(k.created_by IS NULL OR k.created_by <> 'whatsapp')", NULL, FALSE)
            ->order_by('k.date_visit', 'DESC')
            ->get()->result();

        $this->json_response(['success' => true, 'data' => $visits, 'message' => 'OK']);
    }

    public function detail($id) {
        $id = (int) $id; // #44
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

        // #21 — tolak parkir 'menunggu_evaluasi' pada visit non-SKD (dead-end state).
        if ($status === 'menunggu_evaluasi'
            && $this->next_status_after_completion($visit->jenis_layanan) !== 'menunggu_evaluasi') {
            $this->json_response(['success' => false, 'message' => 'Status menunggu_evaluasi hanya untuk layanan SKD.'], 400);
        }

        // Gate finalisasi: selesai/menunggu_evaluasi harus dari role yang berhak atas layanan tsb.
        if (in_array($status, ['selesai', 'menunggu_evaluasi'], true)) {
            $this->require_layanan_role($visit->jenis_layanan);
        }

        // #3 — Soft-correct: layanan SKD yang dikirim 'selesai' dikoreksi ke 'menunggu_evaluasi'
        // agar evaluasi IKM tidak bisa dilewati lewat endpoint DTSEN. Bypass roles override.
        // Parity dgn Visits::status (audit 2026-07-12 #3).
        if ($status === 'selesai') {
            $role = isset($this->current_user->role) ? $this->current_user->role : ''; // #23 fail-closed: role-less token is NOT a bypass
            $is_bypass = in_array($role, ['admin', 'superadmin', 'operator'], true);
            if (!$is_bypass && $this->next_status_after_completion($visit->jenis_layanan) === 'menunggu_evaluasi') {
                $status = 'menunggu_evaluasi';
            }
        }

        // ── Form-complete gates (defense-in-depth) — identik dgn Visits::status. ──
        if (in_array($status, ['selesai', 'menunggu_evaluasi'], true)) {
            // Gate 1: keterangan wajib (Lainnya / Keperluan Pimpinan).
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
            // Gate 2: form SKD wajib (4 layanan inti SKD) — ≥1 baris kebutuhan_data.
            if ($this->layanan_requires_skd_form($visit->jenis_layanan)) {
                $cnt = (int) $this->db->where('id_kunjungan', $id)->where("rincian_data IS NOT NULL AND TRIM(rincian_data) <> ''", NULL, FALSE)->count_all_results('konsultasi_pengunjung');
                if ($cnt === 0) {
                    $this->json_response([
                        'success' => false,
                        'message' => 'Form konsultasi SKD belum lengkap. Isi minimal 1 baris kebutuhan data + ringkasan konsultasi di halaman form konsultasi sebelum menyelesaikan visit.',
                    ], 400);
                }
            }
            // Gate 3: form DTSEN wajib (Konsultasi DTSEN) — 1 baris dtsen_konsultasi.
            if ($status === 'selesai' && $this->layanan_requires_dtsen_form($visit->jenis_layanan)) {
                $cnt = (int) $this->db->where('id_kunjungan', $id)->count_all_results('dtsen_konsultasi');
                if ($cnt === 0) {
                    $this->json_response([
                        'success' => false,
                        'message' => 'Form DTSEN belum diisi. Lengkapi jenis konsultasi, hasil, dan catatan sebelum menyelesaikan.',
                    ], 400);
                }
            }
        }

        $update = ['status' => $status];

        if ($status === 'selesai') {
            $selesai_timestamp           = date('Y-m-d H:i:s');
            $update['selesai_timestamp'] = $selesai_timestamp;
            if ($visit->date_visit) {
                $durasi                 = strtotime($selesai_timestamp) - strtotime($visit->date_visit);
                $update['durasi_detik'] = max(0, $durasi);
            }
        }

        $this->db->where('id_kunjungan', $id)->update('tamdes_kunjungan', $update);
        $updated = $this->db->get_where('tamdes_kunjungan', ['id_kunjungan' => $id])->row();

        // #22 — audit trail parity dgn Visits::status.
        $this->audit('update_status', 'visit', $id, ['from' => $visit->status, 'to' => $status]);

        $this->json_response(['success' => true, 'data' => $updated, 'message' => 'Status berhasil diupdate']);
    }

    /**
     * GET  /api/dtsen/{id}/data  → ambil data DTSEN terbaru untuk visit
     * POST /api/dtsen/{id}/data  → simpan / replace data DTSEN
     *
     * Struktur DTSEN: satu visit = satu row (tidak multi-row seperti SKD).
     * Fields: jenis_konsultasi_dtsen, hasil, catatan, nik_dirujuk.
     */
    public function data($id) {
        $id = (int) $id; // #44
        $this->require_auth();

        if ($_SERVER['REQUEST_METHOD'] === 'GET') {
            $row = $this->db->get_where('dtsen_konsultasi', ['id_kunjungan' => $id])->row();
            $this->json_response(['success' => true, 'data' => $row, 'message' => 'OK']);

        } elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $visit_check = $this->db->select('jenis_layanan, status, date_visit')
                                    ->get_where('tamdes_kunjungan', ['id_kunjungan' => $id])->row();
            if (!$visit_check) {
                $this->json_response(['success' => false, 'message' => 'Kunjungan tidak ditemukan'], 404);
            }
            $this->require_layanan_role($visit_check->jenis_layanan);

            $input = $this->get_json_input();

            $jenis   = isset($input['jenis_konsultasi_dtsen']) ? (int)$input['jenis_konsultasi_dtsen'] : 0;
            $hasil   = isset($input['hasil']) ? (int)$input['hasil'] : 0;
            $catatan = trim((string)($input['catatan'] ?? ''));
            if ($jenis < 1 || $jenis > 5) {
                $this->json_response(['success' => false, 'message' => 'jenis_konsultasi_dtsen tidak valid (1-5).'], 400);
            }
            if ($hasil < 1 || $hasil > 3) {
                $this->json_response(['success' => false, 'message' => 'hasil tidak valid (1-3).'], 400);
            }
            // Form-lengkap gate: catatan wajib non-empty. Tanpa ini visit DTSEN auto-finalize
            // ke 'selesai' tanpa jejak konteks. Sama strict-nya dengan FE isValid.
            if ($catatan === '') {
                $this->json_response(['success' => false, 'message' => 'Catatan wajib diisi.'], 400);
            }

            $row = [
                'id_kunjungan'           => $id,
                'jenis_konsultasi_dtsen' => $jenis,
                'hasil'                  => $hasil,
                'catatan'                => $catatan,
                'nik_dirujuk'            => !empty($input['nik_dirujuk']) ? substr(preg_replace('/\D/', '', $input['nik_dirujuk']), 0, 16) : null,
                'tanggal_input'          => date('Y-m-d H:i:s'),
            ];

            // Upsert: delete existing then insert (single-row per visit semantics).
            $this->db->where('id_kunjungan', $id)->delete('dtsen_konsultasi');
            $this->db->insert('dtsen_konsultasi', $row);
            $saved = $this->db->get_where('dtsen_konsultasi', ['id_kunjungan' => $id])->row();

            // Auto-finalize: DTSEN → 'selesai' langsung (next_status_after_completion
            // sudah mengembalikan 'selesai' untuk DTSEN). Skip kalau visit sudah final.
            if ($visit_check->status !== 'selesai' && $visit_check->status !== 'menunggu_evaluasi') {
                $next_status                 = $this->next_status_after_completion($visit_check->jenis_layanan);
                $update                      = ['status' => $next_status];
                if ($next_status === 'selesai') {
                    $selesai_ts                  = date('Y-m-d H:i:s');
                    $update['selesai_timestamp'] = $selesai_ts;
                    if ($visit_check->date_visit) {
                        $update['durasi_detik'] = max(0, strtotime($selesai_ts) - strtotime($visit_check->date_visit));
                    }
                }
                $this->db->where('id_kunjungan', $id)->update('tamdes_kunjungan', $update);
                $this->audit('save_dtsen', 'visit', $id, ['status_from' => $visit_check->status, 'status_to' => $next_status]);
            }

            $this->json_response(['success' => true, 'data' => $saved, 'message' => 'Data DTSEN berhasil disimpan']);

        } else {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }
    }
}
