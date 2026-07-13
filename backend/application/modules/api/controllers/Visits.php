<?php
defined('BASEPATH') OR exit('No direct script access allowed');

require_once APPPATH . 'modules/api/controllers/Api_base.php';

class Visits extends Api_base {

    public function index() {
        $this->require_auth();

        if ($_SERVER['REQUEST_METHOD'] === 'GET') {
            $q       = $this->input->get('q');
            $layanan = $this->input->get('layanan');
            $status  = $this->input->get('status');
            $tahun   = $this->input->get('tahun');
            $bulan   = $this->input->get('bulan');
            $page    = (int) ($this->input->get('page') ?: 1);
            $limit   = (int) ($this->input->get('limit') ?: 10);
            $offset  = ($page - 1) * $limit;

            $this->db->select('k.*, b.nama, b.nama_instansi')
                     ->from('tamdes_kunjungan k')
                     ->join('tamdes_buku b', 'k.id_user = b.id_user', 'left');

            if ($q) {
                $this->db->group_start();
                $this->db->like('b.nama', $q);
                $this->db->or_like('b.nama_instansi', $q);
                $this->db->or_like('k.jenis_layanan', $q);
                $this->db->or_like('k.status', $q);
                $this->db->group_end();
            }
            if ($layanan) {
                $this->db->like('k.jenis_layanan', $layanan);
            }
            if ($status) {
                $this->db->where('k.status', $status);
            }
            if ($tahun) {
                $this->db->where('YEAR(k.date_visit)', $tahun);
            }
            if ($bulan) {
                $this->db->where('MONTH(k.date_visit)', $bulan);
            }

            $this->db->order_by('k.date_visit', 'DESC');
            $total = $this->db->count_all_results('', false);
            $visits = $this->db->limit($limit, $offset)->get()->result();

            $this->json_response([
                'success' => true,
                'data' => $visits,
                'message' => 'OK',
                'pagination' => [
                    'page' => $page,
                    'limit' => $limit,
                    'total' => $total,
                    'totalPages' => max(1, ceil($total / $limit)),
                ],
            ]);

        } elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $input   = $this->get_json_input();
            $id_user = $input['id_user'] ?? null;

            $jenis_layanan_raw = $input['jenis_layanan'] ?? '';
            $jenis_layanan = is_array($jenis_layanan_raw) ? json_encode($jenis_layanan_raw) : $jenis_layanan_raw;

            if (!$id_user || !$jenis_layanan_raw) {
                $this->json_response(['success' => false, 'message' => 'id_user dan jenis_layanan diperlukan'], 400);
            }

            // Strategy C: tolak cross layanan
            $this->validate_no_cross_layanan($jenis_layanan_raw);
            $this->validate_sarana_for_layanan($jenis_layanan_raw, $input['sarana'] ?? []);

            $nomor_antrian = $this->generate_queue_number(is_array($jenis_layanan_raw) ? ($jenis_layanan_raw[0] ?? '') : $jenis_layanan_raw);

            $sarana_raw = $input['sarana'] ?? [];
            $sarana = is_array($sarana_raw) ? json_encode($sarana_raw) : $sarana_raw;

            $data = [
                'id_user'          => $id_user,
                'jenis_layanan'    => $jenis_layanan,
                'layanan_lainnya'  => $input['layanan_lainnya'] ?? null,
                'sarana'           => $sarana,
                'sarana_lainnya'   => $input['sarana_lainnya'] ?? null,
                'date_visit'       => date('Y-m-d H:i:s'),
                'status'           => 'antri',
                'nomor_antrian'    => $nomor_antrian,
                'created_by'       => 'admin:' . ($this->current_user->username ?? 'unknown'),
            ];

            $this->db->insert('tamdes_kunjungan', $data);
            $new_id = $this->db->insert_id();
            $visit  = $this->db->get_where('tamdes_kunjungan', ['id_kunjungan' => $new_id])->row();

            $this->json_response(['success' => true, 'data' => $visit, 'message' => 'Kunjungan berhasil dibuat'], 201);
        } else {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }
    }

    public function detail($id) {
        $id = (int) $id; // #44
        $this->require_auth();

        if ($_SERVER['REQUEST_METHOD'] === 'GET') {
            $visit = $this->db->select('k.*, b.nama, b.nama_instansi, b.email, b.notel, b.jeniskelamin, b.pendidikan, b.pekerjaan, b.kategori_instansi, b.pemanfaatan, b.pengaduan')
                              ->from('tamdes_kunjungan k')
                              ->join('tamdes_buku b', 'k.id_user = b.id_user', 'left')
                              ->where('k.id_kunjungan', $id)
                              ->get()->row();

            if (!$visit) {
                $this->json_response(['success' => false, 'message' => 'Kunjungan tidak ditemukan'], 404);
            }

            $consultation = $this->db->get_where('konsultasi_pengunjung', ['id_kunjungan' => $id])->result();
            $evaluation   = $this->db->get_where('tamdes_evaluasi_detail', ['id_kunjungan' => $id])->result();
            $dtsen        = $this->db->get_where('dtsen_konsultasi', ['id_kunjungan' => $id])->row();

            $this->json_response([
                'success' => true,
                'data' => [
                    'visit'             => $visit,
                    'consultation'      => $consultation,
                    'evaluation'        => $evaluation,
                    'dtsen'             => $dtsen,
                    // Label untuk indikator IKM (1..16) supaya FE bisa render hasil evaluasi
                    // dengan teks lengkap tanpa harus call endpoint lain.
                    'indikator_labels'  => $this->indikator_list(),
                ],
                'message' => 'OK',
            ]);

        } elseif ($_SERVER['REQUEST_METHOD'] === 'DELETE') {
            // Hapus kunjungan + cascade ke 7 related tables (konsultasi_pengunjung,
            // dtsen_konsultasi, tamdes_evaluasi_detail, wa_sessions, wa_outbox,
            // wa_messages, data_deliveries). Hard delete by design —
            // audit log capture state SEBELUM delete supaya tetap ada history.
            $this->require_role('admin');

            $visit = $this->db->get_where('tamdes_kunjungan', ['id_kunjungan' => $id])->row();
            if (!$visit) {
                $this->json_response(['success' => false, 'message' => 'Kunjungan tidak ditemukan'], 404);
            }

            // Fetch data_deliveries media paths BEFORE row deletion so we can unlink
            // files after all DB deletes succeed (paths are gone once rows are deleted).
            $delivery_media = $this->db->select('media_path')
                ->where('id_kunjungan', $id)
                ->where('media_path IS NOT NULL')
                ->get('data_deliveries')->result();

            // #30 — Atomic hard-delete: audit + 8-table cascade dalam SATU transaksi.
            // Kalau ada satu delete gagal, SEMUA rollback (tidak ada partial state) dan
            // audit 'delete' tidak tertulis (tidak ada history palsu). Media di-unlink
            // HANYA setelah commit sukses supaya file tidak hilang untuk visit yg masih ada.
            $this->db->trans_start();

            // Capture state untuk audit log sebelum row hilang permanen (ikut transaksi).
            $this->audit('delete', 'visit', $id, [
                'nomor_antrian' => $visit->nomor_antrian,
                'jenis_layanan' => $visit->jenis_layanan,
                'date_visit'    => $visit->date_visit,
                'status'        => $visit->status,
                'id_user'       => $visit->id_user,
            ]);

            // Cascade: 7 related tables yang FK ke id_kunjungan (owned-by-visit) + parent.
            $this->db->where('id_kunjungan', $id)->delete('konsultasi_pengunjung');
            $this->db->where('id_kunjungan', $id)->delete('dtsen_konsultasi');
            $this->db->where('id_kunjungan', $id)->delete('tamdes_evaluasi_detail');
            $this->db->where('id_kunjungan', $id)->delete('wa_sessions');
            $this->db->where('id_kunjungan', $id)->delete('wa_outbox');
            $this->db->where('id_kunjungan', $id)->delete('wa_messages');
            $this->db->where('id_kunjungan', $id)->delete('data_deliveries');
            $this->db->where('id_kunjungan', $id)->delete('tamdes_kunjungan');

            $this->db->trans_complete();

            if ($this->db->trans_status() === FALSE) {
                $this->json_response(['success' => false, 'message' => 'Gagal menghapus kunjungan (transaksi dibatalkan).'], 500);
            }

            // Unlink deliverable files AFTER commit sukses — best-effort,
            // basename() prevents traversal, @unlink silences missing-file warnings.
            $media_dir = FCPATH . 'assets/wa_media/';
            foreach ($delivery_media as $row) {
                $path = $media_dir . basename($row->media_path);
                if (is_file($path)) @unlink($path);
            }

            $this->json_response(['success' => true, 'data' => null, 'message' => 'Kunjungan berhasil dihapus']);

        } else {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }
    }

    public function status($id) {
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

        // Soft-correct: kalau layanan SKD (perlu evaluasi) tapi FE kirim 'selesai' langsung,
        // koreksi ke 'menunggu_evaluasi'. Bypass roles boleh override (admin/superadmin/operator).
        if ($status === 'selesai') {
            $role = isset($this->current_user->role) ? $this->current_user->role : ''; // #23 fail-closed: role-less token is NOT a bypass
            $is_bypass = in_array($role, ['admin', 'superadmin', 'operator'], true);
            if (!$is_bypass && $this->next_status_after_completion($visit->jenis_layanan) === 'menunggu_evaluasi') {
                $status = 'menunggu_evaluasi';
            }
        }

        // ── Form-complete gates (defense-in-depth) ──
        // Berlaku untuk semua role — admin/superadmin sekalipun harus isi. Endpoint /api/visits/{id}/status
        // adalah satu dari beberapa jalan finalisasi — Consultations::detail + Dtsen::detail juga punya gate
        // identik agar tidak bisa di-bypass dengan ganti endpoint.
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
            $selesai_timestamp    = date('Y-m-d H:i:s');
            $update['selesai_timestamp'] = $selesai_timestamp;
            if ($visit->date_visit) {
                $durasi = strtotime($selesai_timestamp) - strtotime($visit->date_visit);
                $update['durasi_detik'] = max(0, $durasi);
            }
        }

        $this->db->where('id_kunjungan', $id)->update('tamdes_kunjungan', $update);
        $this->audit('update_status', 'visit', $id, ['from' => $visit->status, 'to' => $status]);
        $updated = $this->db->get_where('tamdes_kunjungan', ['id_kunjungan' => $id])->row();

        $this->json_response(['success' => true, 'data' => $updated, 'message' => 'Status berhasil diupdate']);
    }

    public function service($id) {
        $id = (int) $id; // #44
        $this->require_auth();

        if ($_SERVER['REQUEST_METHOD'] !== 'PUT') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        $input = $this->get_json_input();

        $jenis_layanan_raw = $input['jenis_layanan'] ?? null;
        if (!$jenis_layanan_raw) {
            $this->json_response(['success' => false, 'message' => 'jenis_layanan diperlukan'], 400);
        }

        $old = $this->db->get_where('tamdes_kunjungan', ['id_kunjungan' => $id])->row();
        if (!$old) {
            $this->json_response(['success' => false, 'message' => 'Kunjungan tidak ditemukan'], 404);
        }

        // Role gate: petugas hanya boleh edit visit yang sesuai grupnya (defense-in-depth).
        // Cek dua sisi: layanan LAMA (yang sekarang ada di DB) dan layanan BARU (yang diminta).
        $this->require_layanan_role($old->jenis_layanan);
        $this->require_layanan_role($jenis_layanan_raw);

        $this->validate_no_cross_layanan($jenis_layanan_raw);
        $this->validate_sarana_for_layanan($jenis_layanan_raw, $input['sarana'] ?? []);

        $jenis_layanan = is_array($jenis_layanan_raw) ? json_encode($jenis_layanan_raw) : $jenis_layanan_raw;
        $sarana_raw = $input['sarana'] ?? [];
        $sarana = is_array($sarana_raw) ? json_encode($sarana_raw) : $sarana_raw;

        $update = [
            'jenis_layanan'   => $jenis_layanan,
            'layanan_lainnya' => $input['layanan_lainnya'] ?? null,
            'sarana'          => $sarana,
            'sarana_lainnya'  => $input['sarana_lainnya'] ?? null,
        ];

        $this->db->where('id_kunjungan', $id)->update('tamdes_kunjungan', $update);

        // Audit only real changes
        $changes = [];
        if ($old && $old->jenis_layanan !== $jenis_layanan) $changes['layanan'] = ['from' => $old->jenis_layanan, 'to' => $jenis_layanan];
        if ($old && $old->sarana !== $sarana) $changes['sarana'] = ['from' => $old->sarana, 'to' => $sarana];
        if (!empty($changes)) $this->audit('update_service', 'visit', $id, $changes);

        $updated = $this->db->get_where('tamdes_kunjungan', ['id_kunjungan' => $id])->row();
        $this->json_response(['success' => true, 'data' => $updated, 'message' => 'Layanan & sarana berhasil diupdate']);
    }

    public function summary($id) {
        $id = (int) $id; // #44
        $this->require_auth();

        if ($_SERVER['REQUEST_METHOD'] !== 'PUT') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        // Role gate: petugas hanya boleh edit ringkasan visit yang sesuai grupnya.
        $visit_check = $this->db->select('jenis_layanan')
                                ->get_where('tamdes_kunjungan', ['id_kunjungan' => $id])->row();
        if (!$visit_check) {
            $this->json_response(['success' => false, 'message' => 'Kunjungan tidak ditemukan'], 404);
        }
        $this->require_layanan_role($visit_check->jenis_layanan);

        $input           = $this->get_json_input();
        $hasil_konsultasi = $input['ringkasan'] ?? $input['hasil_konsultasi'] ?? '';

        $existing = $this->db->get_where('konsultasi_pengunjung', ['id_kunjungan' => $id])->row();

        if ($existing) {
            $this->db->where('id_kunjungan', $id)->update('konsultasi_pengunjung', ['hasil_konsultasi' => $hasil_konsultasi]);
        } else {
            $this->db->insert('konsultasi_pengunjung', [
                'id_kunjungan'    => $id,
                'hasil_konsultasi' => $hasil_konsultasi,
                'tanggal_input'   => date('Y-m-d H:i:s'),
            ]);
        }

        $updated = $this->db->get_where('konsultasi_pengunjung', ['id_kunjungan' => $id])->row();

        $this->json_response(['success' => true, 'data' => $updated, 'message' => 'Ringkasan berhasil disimpan']);
    }

}
