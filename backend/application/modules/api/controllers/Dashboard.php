<?php
defined('BASEPATH') OR exit('No direct script access allowed');

require_once APPPATH . 'modules/api/controllers/Api_base.php';

class Dashboard extends Api_base {

    public function stats() {
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }
        $this->require_auth();

        $date_from = $this->input->get('date_from');
        $date_to = $this->input->get('date_to');

        $where = [];
        if ($date_from) $where['date_visit >='] = $date_from;
        if ($date_to) $where['date_visit <='] = $date_to . ' 23:59:59';

        // Total visits
        $this->db->where($where);
        $total_kunjungan = $this->db->count_all_results('tamdes_kunjungan');

        // Unique guests
        $this->db->where($where)->select('COUNT(DISTINCT id_user) as cnt');
        $tamu_unik = (int) $this->db->get('tamdes_kunjungan')->row()->cnt;

        // Days with visits
        $this->db->where($where)->select('COUNT(DISTINCT DATE(date_visit)) as cnt');
        $jumlah_hari = (int) $this->db->get('tamdes_kunjungan')->row()->cnt;

        $rata_rata = $jumlah_hari > 0 ? round($total_kunjungan / $jumlah_hari, 1) : 0;

        // Busiest day
        $this->db->where($where)->select('DATE(date_visit) as dt, COUNT(*) as cnt')
            ->group_by('dt')->order_by('cnt', 'DESC')->limit(1);
        $busiest = $this->db->get('tamdes_kunjungan')->row();
        $hari_tersibuk = $busiest ? $busiest->dt . ' (' . $busiest->cnt . ')' : '-';

        // Active period
        $this->db->where($where)->select('MIN(date_visit) as first_date, MAX(date_visit) as last_date');
        $period = $this->db->get('tamdes_kunjungan')->row();
        $periode_aktif = ($period->first_date && $period->last_date)
            ? date('d M Y', strtotime($period->first_date)) . ' - ' . date('d M Y', strtotime($period->last_date))
            : '-';

        // Completed & queued
        $this->db->where($where)->where('status', 'selesai');
        $selesai = $this->db->count_all_results('tamdes_kunjungan');
        $this->db->where($where)->where('status', 'antri')->where('created_by <>', 'whatsapp');
        $antri = $this->db->count_all_results('tamdes_kunjungan');

        $tingkat_selesai = $total_kunjungan > 0 ? round(($selesai / $total_kunjungan) * 100, 1) : 0;

        // Average duration
        $this->db->where($where)->where('durasi_detik >', 0)->select_avg('durasi_detik', 'avg_dur');
        $avg_dur_row = $this->db->get('tamdes_kunjungan')->row();
        $avg_dur = $avg_dur_row && $avg_dur_row->avg_dur ? round($avg_dur_row->avg_dur / 60) . ' menit' : '-';

        // Most popular service
        $this->db->where($where)->select('jenis_layanan, COUNT(*) as cnt')
            ->group_by('jenis_layanan')->order_by('cnt', 'DESC')->limit(1);
        $top_service = $this->db->get('tamdes_kunjungan')->row();
        $layanan_terbanyak = $top_service ? $top_service->jenis_layanan : '-';

        // Most common institution
        $this->db->select('b.nama_instansi, COUNT(*) as cnt')
            ->from('tamdes_kunjungan k')
            ->join('tamdes_buku b', 'k.id_user = b.id_user');
        if ($date_from) $this->db->where('k.date_visit >=', $date_from);
        if ($date_to) $this->db->where('k.date_visit <=', $date_to . ' 23:59:59');
        $this->db->where('b.nama_instansi !=', '')
            ->group_by('b.nama_instansi')->order_by('cnt', 'DESC')->limit(1);
        $top_inst = $this->db->get()->row();
        $instansi_terbanyak = $top_inst ? $top_inst->nama_instansi : '-';

        $this->json_response([
            'success' => true,
            'data' => [
                'total_kunjungan' => $total_kunjungan,
                'tamu_unik' => $tamu_unik,
                'jumlah_hari' => $jumlah_hari,
                'rata_rata_per_hari' => $rata_rata,
                'hari_tersibuk' => $hari_tersibuk,
                'periode_aktif' => $periode_aktif,
                'selesai' => $selesai,
                'antri' => $antri,
                'tingkat_selesai' => $tingkat_selesai,
                'rata_rata_durasi' => $avg_dur,
                'layanan_terbanyak' => $layanan_terbanyak,
                'instansi_terbanyak' => $instansi_terbanyak,
            ],
            'message' => 'OK',
        ]);
    }

    public function events() {
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }
        $this->require_auth();

        $this->db->select('DATE(date_visit) as date, COUNT(*) as count, jenis_layanan')
            ->group_by('DATE(date_visit), jenis_layanan')
            ->order_by('date', 'ASC');
        $rows = $this->db->get('tamdes_kunjungan')->result();

        $colors = [
            'Perpustakaan' => '#0D9488',
            'Konsultasi Statistik' => '#3B82F6',
            'Rekomendasi Kegiatan Statistik' => '#F59E0B',
            'Penjualan Produk Statistik' => '#8B5CF6',
            'Keperluan Pimpinan' => '#EF4444',
            'Lainnya' => '#6B7280',
        ];

        $events = array_map(function ($row) use ($colors) {
            return [
                'id' => $row->date . '-' . $row->jenis_layanan,
                'title' => $row->jenis_layanan . ' (' . $row->count . ')',
                'start' => $row->date,
                'color' => isset($colors[$row->jenis_layanan]) ? $colors[$row->jenis_layanan] : '#6B7280',
            ];
        }, $rows);

        $this->json_response(['success' => true, 'data' => $events, 'message' => 'OK']);
    }
}
