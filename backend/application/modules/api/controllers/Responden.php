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
                    AND (b.nama LIKE '%" . $this->db->escape_like_str($q) . "%'
                         OR b.nama_instansi LIKE '%" . $this->db->escape_like_str($q) . "%')
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
