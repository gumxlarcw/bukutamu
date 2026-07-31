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
        $this->db->where($where)->where('status', 'antri')->where("(created_by IS NULL OR created_by <> 'whatsapp')", NULL, FALSE);
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

        // Hormati rentang yang sama seperti stats(). Sebelumnya events() selalu
        // memuat SELURUH riwayat, sehingga sorotan dan grafik di halaman yang sama
        // bercerita tentang rentang berbeda tanpa memberi tahu siapa pun.
        $date_from = $this->input->get('date_from');
        $date_to   = $this->input->get('date_to');

        $this->db->select('DATE(date_visit) as date, COUNT(*) as count, jenis_layanan')
            ->group_by('DATE(date_visit), jenis_layanan')
            ->order_by('date', 'ASC');
        if ($date_from) { $this->db->where('DATE(date_visit) >=', $date_from); }
        if ($date_to)   { $this->db->where('DATE(date_visit) <=', $date_to); }
        $rows = $this->db->get('tamdes_kunjungan')->result();

        $events = array_map(function ($row) {
            $layanan = $this->first_layanan_name($row->jenis_layanan);
            return [
                'id'      => $row->date . '-' . $layanan,
                'title'   => $layanan . ' (' . $row->count . ')',
                'start'   => $row->date,
                'color'   => $this->warna_grup_layanan($layanan),
                // Dua field di bawah dipakai grafik dashboard. FullCalendar menyerap
                // kunci tak dikenal ke extendedProps dan mengabaikannya, jadi kalender
                // tidak terpengaruh. Mengurai angka dari `title` ("Perpustakaan (3)")
                // akan diam-diam salah begitu labelnya berubah.
                'count'   => (int) $row->count,
                'layanan' => $layanan,
            ];
        }, $rows);

        $this->json_response(['success' => true, 'data' => $events, 'message' => 'OK']);
    }

    /**
     * `jenis_layanan` tersimpan dalam DUA format: string polos ("Perpustakaan")
     * dan JSON array ('["Perpustakaan","Konsultasi Statistik"]'). Ambil nama
     * pertama supaya event punya satu label yang bisa diwarnai.
     */
    private function first_layanan_name($raw) {
        $raw = trim((string) $raw);
        if ($raw === '') { return 'Tidak diketahui'; }
        if (substr($raw, 0, 1) === '[') {
            $decoded = json_decode($raw, true);
            if (is_array($decoded) && count($decoded) > 0) {
                return (string) $decoded[0];
            }
        }
        return $raw;
    }

    /**
     * Warna per GRUP layanan, bukan per layanan. Peta lama memuat 6 layanan
     * padahal taksonominya 9, sehingga DTSEN, Daftar Antrian Offline, dan
     * Lainnya Online semuanya jatuh ke abu-abu dan tak terbedakan.
     *
     * Empat warna ini SUDAH divalidasi terhadap permukaan #ffffff — lolos
     * lantai chroma, pita lightness, pemisahan buta warna, dan kontras.
     * Jangan diubah tanpa menjalankan ulang validator palet.
     */
    private function warna_grup_layanan($layanan) {
        $skd = ['Perpustakaan', 'Konsultasi Statistik', 'Rekomendasi Kegiatan Statistik', 'Penjualan Produk Statistik'];
        $res = ['Lainnya', 'Keperluan Pimpinan', 'Daftar Antrian Offline'];

        if (in_array($layanan, $skd, true))          { return '#c4570a'; }
        if ($layanan === 'Konsultasi DTSEN')          { return '#0d9499'; }
        if (in_array($layanan, $res, true))           { return '#be185d'; }
        if ($layanan === 'Lainnya Online')            { return '#2563eb'; }
        return '#7a7068'; // di luar taksonomi — sengaja netral, bukan warna kategori
    }
}
