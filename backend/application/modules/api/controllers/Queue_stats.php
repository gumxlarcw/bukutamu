<?php
defined('BASEPATH') OR exit('No direct script access allowed');

require_once APPPATH . 'modules/api/controllers/Api_base.php';

class Queue_stats extends Api_base {

    public function index() {
        $this->require_auth();

        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        $tahun = $this->input->get('tahun') ?: date('Y');

        // ── Operational: durasi layanan ─────────────────────────────────────
        $avg_wait = $this->db->select('AVG(durasi_detik) as avg_durasi, MIN(durasi_detik) as min_durasi, MAX(durasi_detik) as max_durasi, COUNT(*) as total_selesai')
                             ->where('status', 'selesai')
                             ->where('durasi_detik IS NOT NULL')
                             ->where('YEAR(date_visit)', $tahun)
                             ->get('tamdes_kunjungan')->row();

        // ── Visit-level totals (semua status, bukan hanya selesai) ──────────
        $total_visits = (int) $this->db->where('YEAR(date_visit)', $tahun)->count_all_results('tamdes_kunjungan');

        // Distinct visitors (unique id_user). 1 orang bisa banyak kunjungan.
        $distinct_visitors = (int) $this->db->select('COUNT(DISTINCT id_user) as cnt')
                                            ->where('YEAR(date_visit)', $tahun)
                                            ->get('tamdes_kunjungan')->row()->cnt;

        // Repeat-visitor ratio: id_user yang muncul >1× di tahun ini.
        // Computed di PHP supaya tidak butuh subquery yang heavy.
        $visitor_freq = $this->db->select('id_user, COUNT(*) as cnt')
                                 ->where('YEAR(date_visit)', $tahun)
                                 ->group_by('id_user')
                                 ->get('tamdes_kunjungan')->result();
        $repeat_count = 0;
        foreach ($visitor_freq as $v) {
            if ((int) $v->cnt > 1) $repeat_count++;
        }

        // ── Time distributions ──────────────────────────────────────────────
        $hourly = $this->db->select('HOUR(date_visit) as jam, COUNT(*) as jumlah')
                           ->where('YEAR(date_visit)', $tahun)
                           ->group_by('HOUR(date_visit)')
                           ->order_by('jam', 'ASC')
                           ->get('tamdes_kunjungan')->result();

        $daily = $this->db->select('DAYNAME(date_visit) as hari, DAYOFWEEK(date_visit) as dow, COUNT(*) as jumlah')
                          ->where('YEAR(date_visit)', $tahun)
                          ->group_by('DAYOFWEEK(date_visit)')
                          ->order_by('dow', 'ASC')
                          ->get('tamdes_kunjungan')->result();

        // Monthly extended: count + avg durasi (untuk selesai saja).
        $monthly = $this->db->select('MONTH(date_visit) as bulan,
                                      COUNT(*) as jumlah,
                                      AVG(CASE WHEN status="selesai" THEN durasi_detik END) as avg_durasi')
                            ->where('YEAR(date_visit)', $tahun)
                            ->group_by('MONTH(date_visit)')
                            ->order_by('bulan', 'ASC')
                            ->get('tamdes_kunjungan')->result();

        // Per triwulan: count + selesai + avg durasi untuk laporan kuartalan.
        $quarterly = $this->db->select('QUARTER(date_visit) as triwulan,
                                        COUNT(*) as jumlah,
                                        SUM(CASE WHEN status="selesai" THEN 1 ELSE 0 END) as selesai,
                                        AVG(CASE WHEN status="selesai" THEN durasi_detik END) as avg_durasi')
                              ->where('YEAR(date_visit)', $tahun)
                              ->group_by('QUARTER(date_visit)')
                              ->order_by('triwulan', 'ASC')
                              ->get('tamdes_kunjungan')->result();

        // ── Service & status distribution ───────────────────────────────────
        $services = $this->db->select('jenis_layanan, COUNT(*) as jumlah')
                             ->where('YEAR(date_visit)', $tahun)
                             ->group_by('jenis_layanan')
                             ->order_by('jumlah', 'DESC')
                             ->get('tamdes_kunjungan')->result();

        $statuses = $this->db->select('status, COUNT(*) as jumlah')
                             ->where('YEAR(date_visit)', $tahun)
                             ->group_by('status')
                             ->get('tamdes_kunjungan')->result();

        // ── Sumber kunjungan: kiosk vs admin manual entry ───────────────────
        // created_by formats: 'kiosk', 'admin:<username>', null. Normalize ke 3 bucket.
        $source_rows = $this->db->select('created_by, COUNT(*) as jumlah')
                                ->where('YEAR(date_visit)', $tahun)
                                ->group_by('created_by')
                                ->get('tamdes_kunjungan')->result();
        $sources_map = ['Kiosk' => 0, 'Manual (Admin)' => 0, 'WhatsApp' => 0, 'Lainnya' => 0];
        foreach ($source_rows as $r) {
            $cb = (string) $r->created_by;
            if ($cb === 'kiosk')                 $sources_map['Kiosk']           += (int) $r->jumlah;
            elseif ($cb === 'whatsapp')          $sources_map['WhatsApp']        += (int) $r->jumlah;
            elseif (strpos($cb, 'admin:') === 0) $sources_map['Manual (Admin)'] += (int) $r->jumlah;
            else                                  $sources_map['Lainnya']        += (int) $r->jumlah;
        }
        $sources = [];
        foreach ($sources_map as $name => $jumlah) {
            if ($jumlah > 0) $sources[] = ['source' => $name, 'jumlah' => $jumlah];
        }

        // ── Sarana distribution ─────────────────────────────────────────────
        // Kolom `sarana` disimpan sebagai JSON array (`[1, 4]`). MySQL ENUM-style
        // aggregation susah, jadi decode di PHP + tally. Cheap untuk N < ~10k rows.
        $sarana_rows = $this->db->select('sarana')
                                ->where('YEAR(date_visit)', $tahun)
                                ->where('sarana IS NOT NULL')
                                ->where("sarana != ''")
                                ->get('tamdes_kunjungan')->result();
        $sarana_tally = [];
        foreach ($sarana_rows as $r) {
            $codes = json_decode($r->sarana, true);
            if (!is_array($codes)) continue;
            foreach ($codes as $c) {
                $code_int = (int) $c;
                $sarana_tally[$code_int] = ($sarana_tally[$code_int] ?? 0) + 1;
            }
        }
        $sarana_dist = [];
        foreach ($sarana_tally as $code => $jumlah) {
            $sarana_dist[] = ['code' => $code, 'jumlah' => $jumlah];
        }
        usort($sarana_dist, function($a, $b) { return $b['jumlah'] - $a['jumlah']; });

        // ── Top 10 instansi pengunjung ──────────────────────────────────────
        $top_instansi = $this->db->select('b.nama_instansi, b.kategori_instansi, COUNT(*) as jumlah')
                                 ->from('tamdes_kunjungan k')
                                 ->join('tamdes_buku b', 'k.id_user = b.id_user')
                                 ->where('YEAR(k.date_visit)', $tahun)
                                 ->where('b.nama_instansi IS NOT NULL')
                                 ->where("b.nama_instansi != ''")
                                 ->group_by('b.nama_instansi')
                                 ->order_by('jumlah', 'DESC')
                                 ->limit(10)
                                 ->get()->result();

        // ── Demografi: kategori instansi ────────────────────────────────────
        $kategori_instansi = $this->db->select('b.kategori_instansi, COUNT(*) as jumlah')
                                      ->from('tamdes_kunjungan k')
                                      ->join('tamdes_buku b', 'k.id_user = b.id_user')
                                      ->where('YEAR(k.date_visit)', $tahun)
                                      ->where('b.kategori_instansi IS NOT NULL')
                                      ->where("b.kategori_instansi != ''")
                                      ->group_by('b.kategori_instansi')
                                      ->order_by('jumlah', 'DESC')
                                      ->get()->result();

        // ── Demografi: jenis kelamin ────────────────────────────────────────
        $gender_dist = $this->db->select('b.jeniskelamin as gender, COUNT(DISTINCT b.id_user) as jumlah')
                                ->from('tamdes_kunjungan k')
                                ->join('tamdes_buku b', 'k.id_user = b.id_user')
                                ->where('YEAR(k.date_visit)', $tahun)
                                ->where('b.jeniskelamin IS NOT NULL')
                                ->where("b.jeniskelamin != ''")
                                ->group_by('b.jeniskelamin')
                                ->get()->result();

        $this->json_response([
            'success' => true,
            'data' => [
                'avg_wait'          => $avg_wait,
                'total_visits'      => $total_visits,
                'distinct_visitors' => $distinct_visitors,
                'repeat_visitors'   => $repeat_count,
                'hourly'            => $hourly,
                'daily'             => $daily,
                'monthly'           => $monthly,
                'quarterly'         => $quarterly,
                'services'          => $services,
                'statuses'          => $statuses,
                'sources'           => $sources,
                'sarana_dist'       => $sarana_dist,
                'top_instansi'      => $top_instansi,
                'kategori_instansi' => $kategori_instansi,
                'gender_dist'       => $gender_dist,
            ],
            'message' => 'OK',
        ]);
    }
}
