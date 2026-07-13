<?php
defined('BASEPATH') OR exit('No direct script access allowed');

require_once APPPATH . 'modules/api/controllers/Api_base.php';

/**
 * Responden Tahunan — live query dari tamdes_kunjungan + tamdes_buku.
 * Tidak pakai tabel terpisah, selalu real-time dan akurat.
 */
class Responden extends Api_base {

    private $eligible_services = [
        'Perpustakaan',
        'Konsultasi Statistik',
        'Rekomendasi Kegiatan Statistik',
        'Penjualan Produk Statistik',
    ];

    public function index() {
        $this->require_auth();

        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        $tahun    = $this->input->get('tahun') ?: date('Y');
        $q        = $this->input->get('q');
        $triwulan = $this->input->get('triwulan');
        $skd      = $this->input->get('skd');
        $page     = (int) ($this->input->get('page') ?: 1);
        $limit    = (int) ($this->input->get('limit') ?: 10);
        $offset   = ($page - 1) * $limit;

        // ── Count ──
        $total = (int) $this->_base_query($tahun, $q, $triwulan, $skd, true)->get()->row()->cnt;

        // ── Fetch data ──
        $data = $this->_base_query($tahun, $q, $triwulan, $skd, false)
                     ->order_by('max_visit', 'DESC')
                     ->limit($limit, $offset)
                     ->get()->result();

        // Decode JSON strings for frontend
        foreach ($data as &$row) {
            $row->jenis_layanan = $row->layanan_json;
            $row->sarana = $row->sarana_json;
            unset($row->layanan_json, $row->sarana_json);
        }

        // ── Summary: total all + SKD eligible ──
        $total_all = (int) $this->_base_query($tahun, null, $triwulan, null, true)->get()->row()->cnt;
        $skd_eligible = (int) $this->_base_query($tahun, null, $triwulan, '1', true)->get()->row()->cnt;

        $this->json_response([
            'success'    => true,
            'data'       => $data,
            'summary'    => [
                'total_users'  => $total_all,
                'skd_eligible' => $skd_eligible,
            ],
            'pagination' => [
                'page'       => $page,
                'limit'      => $limit,
                'total'      => $total,
                'totalPages' => max(1, ceil($total / $limit)),
            ],
            'message'    => 'OK',
        ]);
    }

    // GET /api/responden/export?tahun=&triwulan=  → one row per EVALUATED visit (SKD survey
    // response), with the per-indikator kepuasan scores. One person with 2 evaluated visits = 2 rows.
    public function export() {
        $this->require_auth();
        $this->require_role('admin');

        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        $year     = (int) ($this->input->get('tahun') ?: date('Y'));
        $triwulan = $this->input->get('triwulan');

        $this->db->select("k.id_kunjungan, k.id_user, k.date_visit, k.nomor_antrian, k.durasi_detik,
                k.jenis_layanan, k.layanan_lainnya, k.sarana, k.sarana_lainnya, k.hasil_konsultasi, k.rating_pengunjung,
                b.tgldatang, b.nama, b.email, b.notel, b.jeniskelamin, b.umur, b.disabilitas, b.jenis_disabilitas,
                b.pendidikan, b.pekerjaan, b.pekerjaan_lainnya, b.kategori_instansi, b.kategori_lainnya,
                b.nama_instansi, b.pemanfaatan, b.pemanfaatan_lainnya, b.pengaduan")
            ->from('tamdes_kunjungan k')
            ->join('tamdes_buku b', 'k.id_user = b.id_user', 'left')
            ->where('YEAR(k.date_visit)', $year)
            ->where('EXISTS (SELECT 1 FROM tamdes_evaluasi_detail ed WHERE ed.id_kunjungan = k.id_kunjungan)', null, false);
        if ($triwulan) {
            $this->db->where('QUARTER(k.date_visit)', (int) $triwulan);
        }
        $visits = $this->db->order_by('k.date_visit', 'ASC')->get()->result();

        // Per-indikator kepuasan, fetched in one query then grouped by visit.
        $ids = array_map(function ($v) { return (int) $v->id_kunjungan; }, $visits);
        $by_visit = [];
        if (!empty($ids)) {
            $rows = $this->db->select('id_kunjungan, indikator_id, kepuasan')
                ->where_in('id_kunjungan', $ids)->get('tamdes_evaluasi_detail')->result();
            foreach ($rows as $r) {
                $by_visit[(int) $r->id_kunjungan][(int) $r->indikator_id] = (int) $r->kepuasan;
            }
        }
        foreach ($visits as $v) {
            $v->indikator = (object) (isset($by_visit[(int) $v->id_kunjungan]) ? $by_visit[(int) $v->id_kunjungan] : []);
        }

        // Rincian data yang diminta (form proses) — bisa beberapa per kunjungan.
        $konsul_by_visit = [];
        if (!empty($ids)) {
            $kp = $this->db->select('id_kunjungan, rincian_data, wilayah_data, tahun_awal, tahun_akhir, level_data, periode_data, status_data, kode_bidang_statistik, digunakan_nasional, kualitas, jenis_publikasi, judul_publikasi, tahun_publikasi')
                ->where_in('id_kunjungan', $ids)->order_by('id', 'ASC')->get('konsultasi_pengunjung')->result();
            foreach ($kp as $row) {
                $konsul_by_visit[(int) $row->id_kunjungan][] = $row;
            }
        }
        foreach ($visits as $v) {
            $v->konsultasi = isset($konsul_by_visit[(int) $v->id_kunjungan]) ? $konsul_by_visit[(int) $v->id_kunjungan] : [];
        }

        $this->json_response([
            'success' => true,
            'data'    => ['visits' => $visits, 'indikator_labels' => $this->indikator_list()],
            'message' => 'OK',
        ]);
    }

    // GET /api/responden/visit/(:num) → rincian "data yang diminta" (konsultasi_pengunjung)
    // untuk SATU kunjungan. Dipakai detail dialog Responden untuk menampilkan detail lengkap
    // per kunjungan. Admin-tier (require_role('admin') = level >= 2, jadi termasuk pimpinan),
    // samakan persis dengan export() supaya model akses konsisten.
    public function visit_detail($id) {
        $this->require_auth();
        $this->require_role('admin');

        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        $id   = (int) $id;
        $rows = $this->db->select('id, id_kunjungan, rincian_data, wilayah_data, tahun_awal, tahun_akhir,
                level_data, periode_data, status_data, kode_bidang_statistik, digunakan_nasional, kualitas,
                jenis_publikasi, judul_publikasi, tahun_publikasi')
            ->where('id_kunjungan', $id)
            ->order_by('id', 'ASC')
            ->get('konsultasi_pengunjung')->result();

        $this->json_response(['success' => true, 'data' => $rows, 'message' => 'OK']);
    }

    /**
     * Build the aggregation query.
     * Groups tamdes_kunjungan by id_user + year, aggregates layanan & sarana.
     */
    private function _base_query($tahun, $q, $triwulan, $skd, $count_mode) {
        $year = intval($tahun);

        if ($count_mode) {
            $this->db->select('COUNT(*) as cnt');
            $this->db->from("(
                SELECT k.id_user
                FROM tamdes_kunjungan k
                WHERE YEAR(k.date_visit) = {$year}
                " . $this->_tw_clause($triwulan) . "
                " . $this->_skd_clause($skd) . "
                AND EXISTS (SELECT 1 FROM tamdes_evaluasi_detail ed WHERE ed.id_kunjungan = k.id_kunjungan)
                GROUP BY k.id_user
            ) sub", false);

            if ($q) {
                // For count with search, need join to buku
                // Rebuild with subquery that includes search
                $this->db->reset_query();
                $this->db->select('COUNT(*) as cnt');
                $this->db->from("(
                    SELECT k.id_user
                    FROM tamdes_kunjungan k
                    JOIN tamdes_buku b ON k.id_user = b.id_user
                    WHERE YEAR(k.date_visit) = {$year}
                    " . $this->_tw_clause($triwulan) . "
                    " . $this->_skd_clause($skd) . "
                    AND EXISTS (SELECT 1 FROM tamdes_evaluasi_detail ed WHERE ed.id_kunjungan = k.id_kunjungan)
                    AND (b.nama LIKE " . $this->db->escape('%' . $this->db->escape_like_str($q) . '%') . "
                         OR b.nama_instansi LIKE " . $this->db->escape('%' . $this->db->escape_like_str($q) . '%') . ")
                    GROUP BY k.id_user
                ) sub", false);
            }
        } else {
            $this->db->select("
                k.id_user,
                b.nama,
                b.email,
                b.notel,
                b.jeniskelamin,
                b.umur,
                b.disabilitas,
                b.jenis_disabilitas,
                b.pendidikan,
                b.pekerjaan,
                b.pekerjaan_lainnya,
                b.kategori_instansi,
                b.kategori_lainnya,
                b.nama_instansi,
                b.pemanfaatan,
                b.pemanfaatan_lainnya,
                CONCAT('[', GROUP_CONCAT(DISTINCT
                    CASE WHEN k.jenis_layanan LIKE '[%'
                         THEN TRIM(LEADING '[' FROM TRIM(TRAILING ']' FROM REPLACE(REPLACE(REPLACE(k.jenis_layanan, CHAR(9), ''), CHAR(10), ''), CHAR(13), '')))
                         ELSE CONCAT('\"', TRIM(REPLACE(REPLACE(REPLACE(k.jenis_layanan, CHAR(9), ''), CHAR(10), ''), CHAR(13), '')), '\"')
                    END
                SEPARATOR ','), ']') as layanan_json,
                GROUP_CONCAT(DISTINCT k.layanan_lainnya SEPARATOR '; ') as layanan_lainnya,
                CONCAT('[', GROUP_CONCAT(DISTINCT
                    CASE WHEN k.sarana LIKE '[%'
                         THEN TRIM(BOTH '[]' FROM k.sarana)
                         ELSE k.sarana
                    END
                SEPARATOR ','), ']') as sarana_json,
                GROUP_CONCAT(DISTINCT k.sarana_lainnya SEPARATOR '; ') as sarana_lainnya,
                MAX(k.date_visit) as max_visit,
                COUNT(k.id_kunjungan) as total_kunjungan
            ", false)
            ->from('tamdes_kunjungan k')
            ->join('tamdes_buku b', 'k.id_user = b.id_user', 'left')
            ->where('YEAR(k.date_visit)', $year);

            // Responden SKD = hanya yang sudah mengisi evaluasi (indikator kepuasan di akhir kunjungan).
            $this->db->where('EXISTS (SELECT 1 FROM tamdes_evaluasi_detail ed WHERE ed.id_kunjungan = k.id_kunjungan)', null, false);

            if ($triwulan) {
                $this->db->where('QUARTER(k.date_visit)', $triwulan);
            }

            if ($skd) {
                $this->db->group_start();
                foreach ($this->eligible_services as $i => $svc) {
                    if ($i === 0) $this->db->like('k.jenis_layanan', $svc);
                    else $this->db->or_like('k.jenis_layanan', $svc);
                }
                $this->db->group_end();
            }

            if ($q) {
                $this->db->group_start()
                         ->like('b.nama', $q)
                         ->or_like('b.nama_instansi', $q)
                         ->group_end();
            }

            $this->db->group_by('k.id_user');
        }

        return $this->db;
    }

    private function _tw_clause($triwulan) {
        if (!$triwulan) return '';
        return "AND QUARTER(k.date_visit) = " . intval($triwulan);
    }

    private function _skd_clause($skd) {
        if (!$skd) return '';
        $parts = [];
        foreach ($this->eligible_services as $svc) {
            $parts[] = "k.jenis_layanan LIKE '%" . addslashes($svc) . "%'";
        }
        return "AND (" . implode(' OR ', $parts) . ")";
    }
}
