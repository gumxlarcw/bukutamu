<?php
defined('BASEPATH') OR exit('No direct script access allowed');

require_once APPPATH . 'modules/api/controllers/Api_base.php';

class Evaluations extends Api_base {

    public function pending() {
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        // Mode terarah: ?id=N → mint token untuk visit SPESIFIK itu (dipakai tombol
        // "Buka Evaluasi" admin + kartu pemilihan di standby saat >1 antri). Hanya
        // kalau visit masih `menunggu_evaluasi` & layanan SKD — sama ketat dengan
        // FIFO, jadi token tetap cuma terbit untuk visit yang memang berhak.
        $requested_id = $this->input->get('id');
        if ($requested_id !== null && $requested_id !== '') {
            $rid   = (int) $requested_id;
            $visit = $this->db->get_where('tamdes_kunjungan', ['id_kunjungan' => $rid])->row();
            if ($visit && $visit->status === 'menunggu_evaluasi' && $this->layanan_requires_skd_form($visit->jenis_layanan)) {
                $visit->kiosk_token = $this->mint_kiosk_token('eval-submit', $rid, 600);
                $this->json_response(['success' => true, 'data' => $visit, 'message' => 'OK']);
            }
            // Tidak eligible (sudah selesai / bukan SKD / tidak ada) → null; FE balik ke standby.
            $this->json_response(['success' => true, 'data' => null, 'message' => 'OK']);
        }

        // Hanya 4 layanan PST yang perlu evaluasi tablet.
        // Resepsionis (Lainnya, Keperluan Pimpinan) skip evaluasi — defense in depth
        // jika ada visit yang lolos ke menunggu_evaluasi tapi bukan PST.
        $candidates = $this->db
            ->order_by('id_kunjungan', 'ASC')
            ->get_where('tamdes_kunjungan', ['status' => 'menunggu_evaluasi'])
            ->result();

        $pst_services = [
            'Perpustakaan',
            'Konsultasi Statistik',
            'Rekomendasi Kegiatan Statistik',
            'Penjualan Produk Statistik',
        ];

        foreach ($candidates as $candidate) {
            $layanan_list = [];
            if (!empty($candidate->jenis_layanan)) {
                $decoded = json_decode($candidate->jenis_layanan, true);
                $layanan_list = is_array($decoded) ? $decoded : [$candidate->jenis_layanan];
            }
            foreach ($layanan_list as $layanan) {
                if (in_array($layanan, $pst_services, true)) {
                    // Mint a 10-min continuation token bound to this id_kunjungan.
                    // Same token covers both fetch (/api/evaluations/{id} GET) and
                    // submit (POST). Tablet keeps it in memory; expires when the
                    // tamu walks away or tablet times out.
                    $candidate->kiosk_token = $this->mint_kiosk_token(
                        'eval-submit',
                        (int) $candidate->id_kunjungan,
                        600
                    );
                    $this->json_response(['success' => true, 'data' => $candidate, 'message' => 'OK']);
                    return;
                }
            }
        }

        $this->json_response(['success' => true, 'data' => null, 'message' => 'OK']);
    }

    // Daftar SEMUA visit yang sedang menunggu evaluasi (SKD saja) + info tampil
    // untuk kartu pemilihan di terminal standby. Tanpa token: token baru di-mint
    // saat kartu dipilih (lewat pending?id=). Public (tablet kiosk tanpa login),
    // sama seperti pending(). Eval menempel ke id_kunjungan, jadi kunjungan ulang
    // pengunjung yang sama muncul sebagai entri terpisah.
    public function pending_list() {
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        $candidates = $this->db
            ->select('k.id_kunjungan, k.jenis_layanan, k.nomor_antrian, k.date_visit, b.nama, b.nama_instansi')
            ->from('tamdes_kunjungan k')
            ->join('tamdes_buku b', 'k.id_user = b.id_user', 'left')
            ->where('k.status', 'menunggu_evaluasi')
            ->order_by('k.id_kunjungan', 'ASC')
            ->get()->result();

        // Filter ke SKD saja (DTSEN/resepsionis tidak pernah menunggu_evaluasi,
        // tapi tetap defense-in-depth seperti pending()).
        $list = array_values(array_filter($candidates, function ($c) {
            return $this->layanan_requires_skd_form($c->jenis_layanan);
        }));

        $this->json_response(['success' => true, 'data' => $list, 'message' => 'OK']);
    }

    public function detail($id) {
        // Both GET (fetch form) and POST (submit eval) require the kiosk-token
        // minted by /api/evaluations/pending. Endpoint stays unauthenticated by
        // JWT (tablet kiosk has no admin login) but the token binds the request
        // to a specific visit that's currently eligible for evaluation.
        $this->require_kiosk_token('eval-submit', (int) $id);

        if ($_SERVER['REQUEST_METHOD'] === 'GET') {
            $indikator = $this->indikator_list();
            $evaluation = $this->db->get_where('tamdes_evaluasi_detail', ['id_kunjungan' => $id])->result();

            // Konsultasi data dengan status 1 (Ya sesuai) atau 2 (Ya tidak sesuai) —
            // tamu perlu beri rating kualitas tiap data yang diperoleh.
            $konsultasi_kualitas = $this->db
                ->select('id, rincian_data, status_data, kualitas')
                ->where('id_kunjungan', $id)
                ->where_in('status_data', [1, 2])
                ->get('konsultasi_pengunjung')->result();

            // Info tamu (nama + instansi) untuk konfirmasi visual di halaman kiosk.
            // Tujuan: tamu memastikan form yang muncul memang untuk dirinya, bukan
            // tamu lain yang masih dalam antrian evaluasi. Kalau nama yang muncul beda,
            // tamu langsung sadar dan tidak salah submit.
            $visitor = $this->db
                ->select('b.nama, b.nama_instansi, k.nomor_antrian, k.jenis_layanan, k.date_visit')
                ->from('tamdes_kunjungan k')
                ->join('tamdes_buku b', 'k.id_user = b.id_user', 'left')
                ->where('k.id_kunjungan', $id)
                ->get()->row();

            $this->json_response([
                'success' => true,
                'data' => [
                    'indikator'           => $indikator,
                    'evaluation'          => $evaluation,
                    'konsultasi_kualitas' => $konsultasi_kualitas,
                    'visitor'             => $visitor,
                ],
                'message' => 'OK',
            ]);

        } elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $input            = $this->get_json_input();
            $skor_keseluruhan = $input['skor_keseluruhan'] ?? null;
            $kepuasan         = $input['kepuasan'] ?? [];
            $kualitas_per_konsultasi = $input['kualitas_per_konsultasi'] ?? [];

            if (!$skor_keseluruhan || !is_numeric($skor_keseluruhan) || $skor_keseluruhan < 1 || $skor_keseluruhan > 10) {
                $this->json_response(['success' => false, 'message' => 'skor_keseluruhan harus antara 1-10'], 400);
            }

            if (!is_array($kepuasan)) {
                $this->json_response(['success' => false, 'message' => 'kepuasan harus berupa array'], 400);
            }

            $visit = $this->db->get_where('tamdes_kunjungan', ['id_kunjungan' => $id])->row();
            if (!$visit) {
                $this->json_response(['success' => false, 'message' => 'Kunjungan tidak ditemukan'], 404);
            }

            // Gate: hanya visit yang sudah menunggu evaluasi (atau sudah selesai, untuk re-submit
            // koreksi) yang boleh menerima POST. Mencegah attacker post fake eval ke visit
            // yang masih antri/diproses. Endpoint sengaja no-auth (tablet kiosk), jadi gate ini
            // adalah satu-satunya defense.
            if (!in_array($visit->status, ['menunggu_evaluasi', 'selesai'], true)) {
                $this->json_response([
                    'success' => false,
                    'message' => 'Evaluasi belum tersedia untuk kunjungan ini (status: ' . $visit->status . ').',
                ], 400);
            }

            // Throttle re-submits on this no-auth (kiosk-token-only) endpoint so a
            // captured/still-valid token can't spam delete+reinsert. First submit
            // (status menunggu_evaluasi) is never throttled; a genuine correction is
            // allowed once the cooldown elapses.
            $cooldown_seconds = 30;
            if ($visit->status === 'selesai' && $visit->selesai_timestamp) {
                $elapsed = time() - strtotime($visit->selesai_timestamp);
                if ($elapsed >= 0 && $elapsed < $cooldown_seconds) {
                    $this->json_response([
                        'success' => false,
                        'message' => 'Evaluasi baru saja disimpan. Tunggu beberapa saat sebelum mengubah.',
                    ], 429);
                }
            }

            // Delete existing evaluation rows to prevent duplicates
            $this->db->where('id_kunjungan', $id)->delete('tamdes_evaluasi_detail');

            // Insert evaluation rows: skala Likert 1-10 untuk kepuasan saja (kepentingan deprecated).
            foreach ($kepuasan as $indikator_id => $val_kepuasan) {
                if (!$val_kepuasan || $val_kepuasan < 1 || $val_kepuasan > 10) continue;

                $this->db->insert('tamdes_evaluasi_detail', [
                    'id_kunjungan' => $id,
                    'indikator_id' => (int) $indikator_id,
                    'kepentingan'  => null,
                    'kepuasan'     => (int) $val_kepuasan,
                ]);
            }

            // Update kualitas per data konsultasi (status_data 1 atau 2)
            if (is_array($kualitas_per_konsultasi)) {
                foreach ($kualitas_per_konsultasi as $konsultasi_id => $val_kualitas) {
                    if (!is_numeric($val_kualitas) || $val_kualitas < 1 || $val_kualitas > 10) continue;
                    $this->db
                        ->where('id', (int) $konsultasi_id)
                        ->where('id_kunjungan', $id)
                        ->update('konsultasi_pengunjung', ['kualitas' => (int) $val_kualitas]);
                }
            }

            // Update kunjungan: rating, status, selesai_timestamp, durasi_detik
            $selesai_timestamp = date('Y-m-d H:i:s');
            $update = [
                'rating_pengunjung'  => $skor_keseluruhan,
                'status'             => 'selesai',
                'selesai_timestamp'  => $selesai_timestamp,
            ];
            if ($visit->date_visit) {
                $durasi             = strtotime($selesai_timestamp) - strtotime($visit->date_visit);
                $update['durasi_detik'] = max(0, $durasi);
            }
            $this->db->where('id_kunjungan', $id)->update('tamdes_kunjungan', $update);

            $this->json_response(['success' => true, 'data' => null, 'message' => 'Evaluasi berhasil disimpan']);
        } else {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }
    }

    public function results($id) {
        $this->require_auth();

        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        $visit = $this->db->select('rating_pengunjung, status, durasi_detik')
                          ->get_where('tamdes_kunjungan', ['id_kunjungan' => $id])
                          ->row();

        if (!$visit) {
            $this->json_response(['success' => false, 'message' => 'Kunjungan tidak ditemukan'], 404);
        }

        $details = $this->db->get_where('tamdes_evaluasi_detail', ['id_kunjungan' => $id])->result();

        $this->json_response([
            'success' => true,
            'data' => [
                'rating_pengunjung' => $visit->rating_pengunjung,
                'status'            => $visit->status,
                'durasi_detik'      => $visit->durasi_detik,
                'details'           => $details,
                'indikator'         => $this->indikator_list(),
            ],
            'message' => 'OK',
        ]);
    }

    /**
     * GET /api/evaluations/summary — all evaluations with avg scores
     */
    public function summary() {
        $this->require_auth();
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        $tahun = $this->input->get('tahun');

        // Per-visit summary
        $this->db->select('d.id_kunjungan, b.nama, k.jenis_layanan, k.date_visit, k.rating_pengunjung,
                           AVG(d.kepentingan) as avg_kepentingan, AVG(d.kepuasan) as avg_kepuasan,
                           COUNT(d.id) as jumlah_indikator')
                 ->from('tamdes_evaluasi_detail d')
                 ->join('tamdes_kunjungan k', 'd.id_kunjungan = k.id_kunjungan')
                 ->join('tamdes_buku b', 'k.id_user = b.id_user', 'left')
                 ->group_by('d.id_kunjungan')
                 ->order_by('k.date_visit', 'DESC');

        if ($tahun) {
            $this->db->where('YEAR(k.date_visit)', $tahun);
        }

        $visits = $this->db->get()->result();

        // Per-indicator average (IKM breakdown)
        $this->db->select('d.indikator_id, AVG(d.kepentingan) as avg_kepentingan, AVG(d.kepuasan) as avg_kepuasan, COUNT(DISTINCT d.id_kunjungan) as responden')
                 ->from('tamdes_evaluasi_detail d')
                 ->join('tamdes_kunjungan k', 'd.id_kunjungan = k.id_kunjungan');

        if ($tahun) {
            $this->db->where('YEAR(k.date_visit)', $tahun);
        }

        $indicators = $this->db->group_by('d.indikator_id')->order_by('d.indikator_id', 'ASC')->get()->result();

        // Overall average
        $this->db->select('AVG(d.kepuasan) as ikm_score, COUNT(DISTINCT d.id_kunjungan) as total_responden')
                 ->from('tamdes_evaluasi_detail d')
                 ->join('tamdes_kunjungan k', 'd.id_kunjungan = k.id_kunjungan');

        if ($tahun) {
            $this->db->where('YEAR(k.date_visit)', $tahun);
        }

        $overall = $this->db->get()->row();

        // Per-bulan: IKM rata-rata + jumlah responden distinct per bulan.
        // Group by bulan (1-12). Kalau filter tahun null, agregat lintas tahun masih per bulan
        // (mis. Januari 2024 + Januari 2025 jadi satu bucket). Untuk view tahun-spesifik (default
        // currentYear) ini = murni 12 bulan dalam tahun itu.
        $this->db->select('MONTH(k.date_visit) as bulan,
                           AVG(d.kepuasan) as ikm_score,
                           COUNT(DISTINCT d.id_kunjungan) as responden')
                 ->from('tamdes_evaluasi_detail d')
                 ->join('tamdes_kunjungan k', 'd.id_kunjungan = k.id_kunjungan');

        if ($tahun) {
            $this->db->where('YEAR(k.date_visit)', $tahun);
        }

        $monthly = $this->db->group_by('MONTH(k.date_visit)')
                            ->order_by('bulan', 'ASC')
                            ->get()->result();

        // Per-triwulan: IKM rata-rata + jumlah responden per Q1-Q4.
        // QUARTER(date) returns 1-4. Berguna untuk laporan triwulanan ke pimpinan
        // (lebih readable dari 12 bulan, dan match siklus pelaporan birokrasi).
        $this->db->select('QUARTER(k.date_visit) as triwulan,
                           AVG(d.kepuasan) as ikm_score,
                           COUNT(DISTINCT d.id_kunjungan) as responden')
                 ->from('tamdes_evaluasi_detail d')
                 ->join('tamdes_kunjungan k', 'd.id_kunjungan = k.id_kunjungan');
        if ($tahun) {
            $this->db->where('YEAR(k.date_visit)', $tahun);
        }
        $quarterly = $this->db->group_by('QUARTER(k.date_visit)')
                              ->order_by('triwulan', 'ASC')
                              ->get()->result();

        $this->json_response([
            'success' => true,
            'data'    => [
                'visits'     => $visits,
                'indicators' => $indicators,
                'overall'    => $overall,
                'monthly'    => $monthly,
                'quarterly'  => $quarterly,
                'labels'     => $this->indikator_list(),
            ],
            'message' => 'OK',
        ]);
    }

    /* indikator_list() telah dipindahkan ke Api_base::indikator_list() agar controller
       lain (mis. Visits::detail) bisa render hasil evaluasi dengan label yang benar. */
}
