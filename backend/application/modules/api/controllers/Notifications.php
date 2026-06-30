<?php
defined('BASEPATH') OR exit('No direct script access allowed');

require_once APPPATH . 'modules/api/controllers/Api_base.php';

/**
 * Notification feed per role — bell icon di TopNav memanggil endpoint ini tiap N detik.
 *
 * Filosofi: notifikasi adalah DERIVED STATE, bukan tabel terpisah. Setiap request
 * query agregat dari tabel sumber (`tamdes_kunjungan`, `konsultasi_pengunjung`, dll).
 * Keuntungan: selalu sync dengan realita, tidak butuh delete/mark-as-read, idempoten.
 * Trade-off: cost per request = beberapa COUNT/JOIN. Index sudah ada di kolom relevan.
 *
 * Untuk menambah/ubah rule, edit method `rules_for_role()` di bawah.
 */
class Notifications extends Api_base {

    public function index() {
        $this->require_auth();

        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        $role = isset($this->current_user->role) ? $this->current_user->role : 'operator';
        $notifications = $this->rules_for_role($role);

        $this->json_response([
            'success' => true,
            'data'    => [
                'notifications' => $notifications,
                'count'         => count($notifications),
            ],
            'message' => 'OK',
        ]);
    }

    /**
     * Internal feed for the Node notifier service (Web Push sender). NOT for the
     * browser — guarded by X-Internal-Secret + loopback only (see
     * Api_base::require_internal_secret). Returns every push subscription plus the
     * computed notifications for each distinct subscribed role, so the notifier
     * can diff "new" notifications and push them to the right subscriptions.
     */
    public function dispatch() {
        $this->require_internal_secret();

        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        $subs = $this->db
            ->select('endpoint, endpoint_hash, p256dh, auth, role')
            ->get('push_subscriptions')->result();

        $roles = [];
        foreach ($subs as $s) {
            $roles[$s->role] = true;
        }

        $by_role = [];
        foreach (array_keys($roles) as $role) {
            $by_role[$role] = $this->rules_for_role($role);
        }

        $this->json_response([
            'success' => true,
            'data'    => [
                'subscriptions'         => $subs,
                'notifications_by_role' => $by_role,
            ],
            'message' => 'OK',
        ]);
    }

    /**
     * Notification rule registry per role.
     *
     * Setiap rule = method privat yang return array notification (boleh kosong).
     * Format notification:
     *   [
     *     'id'         => 'unique-id-string',     // stable id (mis. "keterangan-empty:643")
     *     'type'       => 'critical'|'warning'|'info',
     *     'title'      => 'Short title (40 char)',
     *     'message'    => 'Body penjelasan singkat',
     *     'action_url' => '/admin/visits',         // route FE saat di-klik
     *     'count'      => 3,                       // opsional, ditampilkan kalau ada
     *     'ts'         => 1716123456,              // unix timestamp untuk sort
     *   ]
     */
    private function rules_for_role($role) {
        $out = [];

        // Resepsionis: visit Lainnya/Pimpinan yang sedang proses tapi keterangan kosong.
        // Bisa diselesaikan kalau resepsionis isi ringkasan dulu.
        if (in_array($role, ['resepsionis', 'admin', 'superadmin'], true)) {
            $rows = $this->resepsionis_keterangan_pending();
            if (!empty($rows)) $out = array_merge($out, $rows);
        }

        // Petugas PST: visit SKD inti yang antri/dipanggil/proses hari ini.
        if (in_array($role, ['petugas_pst', 'admin', 'superadmin', 'operator'], true)) {
            $row = $this->pst_queue_active();
            if ($row !== null) $out[] = $row;
        }

        // Petugas PST: visit DTSEN yang antri/dipanggil/proses hari ini.
        if (in_array($role, ['petugas_pst', 'admin', 'superadmin', 'operator'], true)) {
            $row = $this->dtsen_queue_active();
            if ($row !== null) $out[] = $row;
        }

        // Petugas PST: permintaan data online via WhatsApp yang menunggu diproses.
        if (in_array($role, ['petugas_pst', 'admin', 'superadmin', 'operator'], true)) {
            $rows = $this->pst_wa_online();
            if (!empty($rows)) $out = array_merge($out, $rows);
        }

        // Petugas PST: visit SKD yang sudah diproses tapi form konsultasi belum tersimpan.
        // Visit nyangkut di 'proses' karena petugas belum klik Simpan di form.
        if (in_array($role, ['petugas_pst', 'admin', 'superadmin'], true)) {
            $rows = $this->pst_form_missing();
            if (!empty($rows)) $out = array_merge($out, $rows);
        }

        // Admin/Superadmin: visit stuck di menunggu_evaluasi >24 jam (tamu lupa eval atau tablet bermasalah).
        if (in_array($role, ['admin', 'superadmin'], true)) {
            $row = $this->stuck_evaluation();
            if ($row !== null) $out[] = $row;
        }

        // Verifikator: data_deliveries menunggu diverifikasi.
        if (in_array($role, ['verifikator', 'admin', 'superadmin'], true)) {
            $cnt = (int) $this->db->where('status', 'menunggu_verifikasi')->count_all_results('data_deliveries');
            if ($cnt > 0) {
                $out[] = [
                    'id'         => 'verif_pending',
                    'type'       => 'info',
                    'title'      => 'Verifikasi data menunggu',
                    'message'    => "$cnt permintaan menunggu verifikasi",
                    'action_url' => '/admin/verifikasi',
                    'count'      => $cnt,
                    'ts'         => time(),
                ];
            }
        }

        // Petugas PST: data_deliveries dikembalikan verifikator (revisi).
        if (in_array($role, ['petugas_pst', 'admin', 'superadmin', 'operator'], true)) {
            $rev = (int) $this->db->where('status', 'revisi')->count_all_results('data_deliveries');
            if ($rev > 0) {
                $out[] = [
                    'id'         => 'delivery_revisi',
                    'type'       => 'warning',
                    'title'      => 'Data perlu revisi',
                    'message'    => "$rev pengiriman dikembalikan verifikator",
                    'action_url' => '/admin/layanan-online',
                    'count'      => $rev,
                    'ts'         => time(),
                ];
            }
        }

        // Sort by ts DESC (terbaru di atas), lalu critical > warning > info dalam ts yang sama.
        $severity_order = ['critical' => 0, 'warning' => 1, 'info' => 2];
        usort($out, function($a, $b) use ($severity_order) {
            $sa = $severity_order[$a['type']] ?? 9;
            $sb = $severity_order[$b['type']] ?? 9;
            if ($sa !== $sb) return $sa - $sb;
            return ($b['ts'] ?? 0) - ($a['ts'] ?? 0);
        });

        return $out;
    }

    // ── Rule implementations ────────────────────────────────────────────

    /**
     * Visit kategori Lainnya/Pimpinan yang status=proses (atau antri/dipanggil)
     * dan belum punya hasil_konsultasi non-empty → resepsionis perlu isi keterangan.
     * Mengembalikan SATU notification per visit supaya bisa di-link langsung.
     */
    private function resepsionis_keterangan_pending() {
        $sql = "
            SELECT k.id_kunjungan, b.nama, k.date_visit
            FROM tamdes_kunjungan k
            LEFT JOIN tamdes_buku b ON k.id_user = b.id_user
            LEFT JOIN konsultasi_pengunjung c ON c.id_kunjungan = k.id_kunjungan
            WHERE DATE(k.date_visit) = CURDATE()
              AND k.status IN ('antri', 'dipanggil', 'proses')
              AND (
                k.jenis_layanan LIKE '%Lainnya%'
                OR k.jenis_layanan LIKE '%Keperluan Pimpinan%'
              )
            GROUP BY k.id_kunjungan
            HAVING COALESCE(MAX(NULLIF(TRIM(c.hasil_konsultasi), '')), '') = ''
            ORDER BY k.date_visit DESC
            LIMIT 20
        ";
        $rows = $this->db->query($sql)->result();
        $out = [];
        foreach ($rows as $r) {
            $out[] = [
                'id'         => 'keterangan-empty:' . $r->id_kunjungan,
                'type'       => 'warning',
                'title'      => 'Isi keterangan untuk ' . ($r->nama ?: 'tamu'),
                'message'    => 'Visit Keperluan Pimpinan/Lainnya butuh keterangan sebelum diselesaikan.',
                'action_url' => '/admin/visits',
                'ts'         => strtotime($r->date_visit),
            ];
        }
        return $out;
    }

    /**
     * Permintaan data ONLINE (WhatsApp) yang sudah submit & menunggu diproses
     * (created_by='whatsapp', status antri/dipanggil/diproses). Satu notifikasi per
     * permintaan (id unik) → notifier mem-push setiap permintaan baru; bell juga menampilkannya.
     * Mengarah ke /admin/layanan-online (bukan antrian fisik).
     */
    private function pst_wa_online() {
        $out = [];

        // (1) Sudah submit form → menunggu diproses.
        $rows = $this->db
            ->select('k.id_kunjungan, b.nama, k.date_visit')
            ->from('tamdes_kunjungan k')
            ->join('tamdes_buku b', 'k.id_user = b.id_user', 'left')
            ->where('k.created_by', 'whatsapp')
            ->where_in('k.status', ['antri', 'dipanggil', 'diproses'])
            ->order_by('k.id_kunjungan', 'DESC')
            ->limit(20)
            ->get()->result();
        foreach ($rows as $r) {
            $out[] = [
                'id'         => 'wa-online:' . $r->id_kunjungan,
                'type'       => 'info',
                'title'      => 'Permintaan online: ' . ($r->nama ?: 'tamu WhatsApp'),
                'message'    => 'Permintaan data via WhatsApp menunggu diproses.',
                'action_url' => '/admin/layanan-online',
                'ts'         => strtotime($r->date_visit),
            ];
        }

        // (2) Sudah dikirimi tautan tapi BELUM isi form (awaiting_form, dalam 48 jam).
        $pend = $this->db
            ->select('id, phone_norm, last_inbound_at, created_at')
            ->where('state', 'awaiting_form')
            ->where('created_at >', date('Y-m-d H:i:s', time() - 48 * 3600))
            ->order_by('id', 'DESC')
            ->limit(20)
            ->get('wa_sessions')->result();
        foreach ($pend as $s) {
            $name = $this->wa_known_name_notif($s->phone_norm);
            $out[] = [
                'id'         => 'wa-pending:' . $s->id,
                'type'       => 'info',
                'title'      => 'Menunggu isi form: ' . ($name ?: $s->phone_norm),
                'message'    => 'Kontak WhatsApp sudah dikirimi tautan, belum mengisi form.',
                'action_url' => '/admin/layanan-online',
                'ts'         => strtotime($s->last_inbound_at ?: $s->created_at),
            ];
        }
        return $out;
    }

    // Nama dari DB single-match by nomor (privasi: hanya kalau cocok unik), untuk label notifikasi.
    private function wa_known_name_notif($phone_norm) {
        $m = $this->db->select('nama')->where('notel', $phone_norm)->limit(2)->get('tamdes_buku')->result();
        return (count($m) === 1 && trim((string) $m[0]->nama) !== '') ? $m[0]->nama : null;
    }

    /**
     * Total visit SKD inti hari ini yang masih antri/dipanggil/proses.
     * Satu notification aggregate (count) — biar bell tidak penuh per visit.
     */
    private function pst_queue_active() {
        $cnt = (int) $this->db
            ->where('DATE(date_visit)', date('Y-m-d'))
            ->where_in('status', ['antri', 'dipanggil', 'proses'])
            ->where("(created_by IS NULL OR created_by <> 'whatsapp')", NULL, FALSE)   // WA visits are not in the physical antrian
            ->group_start()
                ->like('jenis_layanan', 'Perpustakaan')
                ->or_like('jenis_layanan', 'Konsultasi Statistik')
                ->or_like('jenis_layanan', 'Rekomendasi Kegiatan Statistik')
                ->or_like('jenis_layanan', 'Penjualan Produk Statistik')
            ->group_end()
            ->count_all_results('tamdes_kunjungan');
        if ($cnt === 0) return null;
        return [
            'id'         => 'pst-queue-active',
            'type'       => 'info',
            'title'      => $cnt . ' tamu di Antrian PST',
            'message'    => 'Tamu menunggu di antrian SKD inti hari ini.',
            'action_url' => '/admin/consultations',
            'count'      => $cnt,
            'ts'         => time(),
        ];
    }

    /**
     * Total visit DTSEN hari ini yang masih antri/dipanggil/proses.
     */
    private function dtsen_queue_active() {
        $cnt = (int) $this->db
            ->where('DATE(date_visit)', date('Y-m-d'))
            ->where_in('status', ['antri', 'dipanggil', 'proses'])
            ->like('jenis_layanan', 'Konsultasi DTSEN')
            ->count_all_results('tamdes_kunjungan');
        if ($cnt === 0) return null;
        return [
            'id'         => 'dtsen-queue-active',
            'type'       => 'info',
            'title'      => $cnt . ' tamu di Antrian DTSEN',
            'message'    => 'Tamu menunggu konsultasi DTSEN hari ini.',
            'action_url' => '/admin/dtsen',
            'count'      => $cnt,
            'ts'         => time(),
        ];
    }

    /**
     * Visit SKD yang sudah mulai diproses (status=proses) tapi belum ada baris
     * konsultasi_pengunjung — petugas lupa save form. Per-visit notification
     * supaya bisa langsung di-link ke form yang sesuai.
     */
    private function pst_form_missing() {
        $sql = "
            SELECT k.id_kunjungan, b.nama, k.date_visit
            FROM tamdes_kunjungan k
            LEFT JOIN tamdes_buku b ON k.id_user = b.id_user
            LEFT JOIN konsultasi_pengunjung c ON c.id_kunjungan = k.id_kunjungan
            WHERE DATE(k.date_visit) = CURDATE()
              AND k.status = 'proses'
              AND (
                k.jenis_layanan LIKE '%Perpustakaan%'
                OR k.jenis_layanan LIKE '%Konsultasi Statistik%'
                OR k.jenis_layanan LIKE '%Rekomendasi Kegiatan Statistik%'
                OR k.jenis_layanan LIKE '%Penjualan Produk Statistik%'
              )
            GROUP BY k.id_kunjungan
            HAVING COUNT(c.id) = 0
            ORDER BY k.date_visit DESC
            LIMIT 20
        ";
        $rows = $this->db->query($sql)->result();
        $out = [];
        foreach ($rows as $r) {
            $out[] = [
                'id'         => 'pst-form-missing:' . $r->id_kunjungan,
                'type'       => 'warning',
                'title'      => 'Lengkapi form SKD untuk ' . ($r->nama ?: 'tamu'),
                'message'    => 'Visit sudah diproses tapi data konsultasi belum tersimpan.',
                'action_url' => '/admin/consultations/' . $r->id_kunjungan . '/form',
                'ts'         => strtotime($r->date_visit),
            ];
        }
        return $out;
    }

    /**
     * Visit stuck di menunggu_evaluasi > 24 jam — kemungkinan tamu lupa evaluasi
     * atau tablet kiosk error. Admin perlu intervensi manual (mark selesai atau follow-up).
     */
    private function stuck_evaluation() {
        $cnt = (int) $this->db
            ->where('status', 'menunggu_evaluasi')
            ->where('date_visit <', date('Y-m-d H:i:s', time() - 86400))
            ->count_all_results('tamdes_kunjungan');
        if ($cnt === 0) return null;
        return [
            'id'         => 'stuck-eval',
            'type'       => 'critical',
            'title'      => $cnt . ' visit stuck di evaluasi >24 jam',
            'message'    => 'Tamu kemungkinan lupa isi evaluasi atau tablet error. Perlu follow-up manual.',
            'action_url' => '/admin/visits?status=menunggu_evaluasi',
            'count'      => $cnt,
            'ts'         => time() - 86400,
        ];
    }
}
