<?php
defined('BASEPATH') OR exit('No direct script access allowed');

require_once APPPATH . 'modules/api/controllers/Api_base.php';

class Wa extends Api_base {

    /* ───────────────────────── internal-secret (connector ↔ backend) ───────────────────────── */

    // POST /api/wa/ingest  { phone, text }
    public function ingest() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_internal_secret();

        $input     = $this->get_json_input();
        $phone_raw = trim((string) ($input['phone'] ?? ''));
        if ($phone_raw === '') $this->json_response(['success' => false, 'message' => 'phone diperlukan'], 400);
        $phone_norm = $this->normalize_phone($phone_raw);

        // Open (awaiting_form) session already? → continuation, no new link.
        $open = $this->db->where('phone_norm', $phone_norm)->where('state', 'awaiting_form')
                         ->order_by('id', 'DESC')->limit(1)->get('wa_sessions')->row();
        if ($open) {
            $this->db->where('id', $open->id)->update('wa_sessions', ['last_inbound_at' => date('Y-m-d H:i:s')]);
            $this->json_response(['success' => true, 'data' => ['session_id' => (int) $open->id, 'new' => false], 'message' => 'OK']);
        }

        // New session → mint link token (48h) → enqueue intake_link.
        $this->db->insert('wa_sessions', [
            'phone_norm'      => $phone_norm,
            'phone_raw'       => $phone_raw,
            'state'           => 'awaiting_form',
            'last_inbound_at' => date('Y-m-d H:i:s'),
        ]);
        $sid   = (int) $this->db->insert_id();
        $token = $this->mint_kiosk_token('wa-intake', $sid, 48 * 3600);
        $link  = $this->wa_public_base() . '/layanan-online/' . $sid . '?t=' . rawurlencode($token);
        $this->db->where('id', $sid)->update('wa_sessions', ['link_sent_at' => date('Y-m-d H:i:s')]);

        $body = "Halo #SahabatData, terima kasih telah menghubungi BPS Provinsi Maluku Utara.\n"
              . "Silakan lengkapi permintaan data Anda melalui tautan berikut (berlaku 48 jam):\n" . $link;
        $this->db->insert('wa_outbox', ['phone_raw' => $phone_raw, 'msg_type' => 'intake_link', 'body' => $body, 'status' => 'pending']);

        $this->json_response(['success' => true, 'data' => ['session_id' => $sid, 'new' => true], 'message' => 'OK']);
    }

    // POST /api/wa/poll  → idempotent dispatch scan, then return pending outbox
    public function poll() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_internal_secret();

        $this->wa_dispatch_scan();

        $pending = $this->db->where('status', 'pending')->order_by('id', 'ASC')->limit(50)->get('wa_outbox')->result();
        $messages = array_map(function ($m) {
            return ['id' => (int) $m->id, 'phone' => $m->phone_raw, 'body' => $m->body];
        }, $pending);
        $this->json_response(['success' => true, 'data' => ['messages' => $messages], 'message' => 'OK']);
    }

    // POST /api/wa/ack  { ids:[...] }
    public function ack() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_internal_secret();

        $input = $this->get_json_input();
        $ids   = (isset($input['ids']) && is_array($input['ids'])) ? array_map('intval', $input['ids']) : [];
        if ($ids) $this->db->where_in('id', $ids)->update('wa_outbox', ['status' => 'sent', 'sent_at' => date('Y-m-d H:i:s')]);
        $this->json_response(['success' => true, 'data' => ['acked' => count($ids)], 'message' => 'OK']);
    }

    /* ───────────────────────── admin (Layanan Online inbox) ───────────────────────── */

    // GET /api/wa/inbox  — WA visits with guest + request summary
    public function inbox() {
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_auth();

        $rows = $this->db
            ->select('k.id_kunjungan, k.status, k.date_visit, k.selesai_timestamp, b.nama, b.nama_instansi, b.notel')
            ->select("(SELECT COUNT(*) FROM konsultasi_pengunjung kp WHERE kp.id_kunjungan = k.id_kunjungan AND kp.rincian_data IS NOT NULL AND TRIM(kp.rincian_data) <> '') AS has_konsultasi", FALSE)
            ->select("(SELECT GROUP_CONCAT(kp.rincian_data SEPARATOR ' · ') FROM konsultasi_pengunjung kp WHERE kp.id_kunjungan = k.id_kunjungan) AS permintaan", FALSE)
            ->from('tamdes_kunjungan k')
            ->join('tamdes_buku b', 'k.id_user = b.id_user', 'left')
            ->where('k.created_by', 'whatsapp')
            ->order_by('k.id_kunjungan', 'DESC')
            ->limit(200)
            ->get()->result();

        $this->json_response(['success' => true, 'data' => $rows, 'message' => 'OK']);
    }

    /* ───────────────────────── public, kiosk-token guarded (requester browser) ───────────────────────── */

    // GET prefill / POST submit : /api/wa/session/(:num)
    public function session($id) {
        $id = (int) $id;
        $this->require_kiosk_token('wa-intake', $id);

        $sess = $this->db->get_where('wa_sessions', ['id' => $id])->row();
        if (!$sess) $this->json_response(['success' => false, 'message' => 'Sesi tidak ditemukan'], 404);

        if ($_SERVER['REQUEST_METHOD'] === 'GET') {
            $matches = $this->db->where('notel', $sess->phone_norm)->order_by('id_user', 'DESC')->get('tamdes_buku')->result();
            $guest = null; $multi = false;
            if (count($matches) === 1)      { $guest = $matches[0]; }
            elseif (count($matches) > 1)    { $guest = $matches[0]; $multi = true; } // R5: most-recent + flag
            $this->json_response(['success' => true, 'data' => [
                'session_id'  => $id,
                'phone'       => $sess->phone_norm,
                'state'       => $sess->state,
                'guest'       => $guest,
                'multi_match' => $multi,
            ], 'message' => 'OK']);
        }

        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $this->require_rate_limit('wa/intake', 30);

            // Idempotent: already submitted → return existing ticket.
            if ($sess->state === 'submitted' && $sess->id_kunjungan) {
                $this->json_response(['success' => true, 'data' => ['id_kunjungan' => (int) $sess->id_kunjungan, 'ticket' => 'WA-' . $sess->id_kunjungan], 'message' => 'Sudah dikirim']);
            }

            $input = $this->get_json_input();

            // SERVER-AUTHORITATIVE — never trust client for these (R8, D2/D3/D5).
            $jenis_layanan = ['Konsultasi Statistik'];
            $sarana        = [2];
            $this->validate_no_cross_layanan($jenis_layanan);
            $this->validate_sarana_for_layanan($jenis_layanan, $sarana);

            // Guest upsert by phone (LOCK pattern from Kiosk::register).
            $this->db->query('LOCK TABLES tamdes_buku WRITE, tamdes_kunjungan WRITE, tamdes_responden_tahunan WRITE');
            $existing = $this->db->where('notel', $sess->phone_norm)->order_by('id_user', 'DESC')->limit(1)->get('tamdes_buku')->row();
            if ($existing) {
                $id_user = (int) $existing->id_user;
                $patch   = $this->wa_profile_patch($existing, $input); // progressive profiling: fill empties only
                if ($patch) $this->db->where('id_user', $id_user)->update('tamdes_buku', $patch);
            } else {
                $max     = $this->db->select_max('id_user')->get('tamdes_buku')->row()->id_user;
                $id_user = $max ? $max + 1 : 8200001;
                $this->db->insert('tamdes_buku', $this->wa_guest_data($id_user, $sess->phone_norm, $input));
                if ($this->db->affected_rows() < 1) { $this->db->query('UNLOCK TABLES'); $this->json_response(['success' => false, 'message' => 'Gagal menyimpan data tamu'], 500); }
            }

            $this->db->insert('tamdes_kunjungan', [
                'id_user'       => $id_user,
                'jenis_layanan' => json_encode($jenis_layanan),
                'sarana'        => json_encode($sarana),
                'date_visit'    => date('Y-m-d H:i:s'),
                'status'        => 'antri',
                'nomor_antrian' => null,
                'created_by'    => 'whatsapp',
            ]);
            $id_kunjungan = (int) $this->db->insert_id();
            if (!$id_kunjungan) { $this->db->query('UNLOCK TABLES'); $this->json_response(['success' => false, 'message' => 'Gagal membuat kunjungan'], 500); }
            $this->db->query('UNLOCK TABLES');

            // Permintaan Data rows (Block B) → konsultasi_pengunjung (D4).
            $rows = (isset($input['permintaan']) && is_array($input['permintaan'])) ? $input['permintaan'] : [];
            $inserted = 0;
            foreach ($rows as $r) {
                $rincian = trim((string) ($r['rincian_data'] ?? ''));
                if ($rincian === '') continue;
                $this->db->insert('konsultasi_pengunjung', [
                    'id_kunjungan' => $id_kunjungan,
                    'rincian_data' => $rincian,
                    'wilayah_data' => (isset($r['wilayah_data']) && $r['wilayah_data'] !== '') ? $r['wilayah_data'] : null,
                    'tahun_awal'   => !empty($r['tahun_awal'])   ? (int) $r['tahun_awal']   : null,
                    'tahun_akhir'  => !empty($r['tahun_akhir'])  ? (int) $r['tahun_akhir']  : null,
                    'level_data'   => !empty($r['level_data'])   ? (int) $r['level_data']   : null,
                    'periode_data' => !empty($r['periode_data']) ? (int) $r['periode_data'] : null,
                    'status_data'  => 4, // Belum Diperoleh (petugas fills outcome later)
                ]);
                $inserted++;
            }

            $this->db->where('id', $id)->update('wa_sessions', ['state' => 'submitted', 'id_kunjungan' => $id_kunjungan, 'submitted_at' => date('Y-m-d H:i:s')]);
            $this->audit_system('create_wa', 'visit', $id_kunjungan, ['id_user' => $id_user, 'konsultasi_rows' => $inserted]);

            $body = "Terima kasih, permintaan data Anda telah kami terima.\nNomor tiket: WA-{$id_kunjungan}.\n"
                  . "Akan kami proses pada jam operasional layanan (Senin–Jumat 08.00–15.30 WIT).";
            $this->db->insert('wa_outbox', ['phone_raw' => $sess->phone_raw, 'msg_type' => 'confirmation', 'body' => $body, 'id_kunjungan' => $id_kunjungan, 'status' => 'pending']);

            $this->json_response(['success' => true, 'data' => ['id_kunjungan' => $id_kunjungan, 'ticket' => 'WA-' . $id_kunjungan], 'message' => 'Permintaan terkirim']);
        }

        $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
    }

    // GET /api/wa/eval/(:num) → exchange a durable wa-eval-access token for a short eval-submit token (D6)
    public function eval_access($id) {
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $id = (int) $id;
        $this->require_kiosk_token('wa-eval-access', $id);

        $visit = $this->db->get_where('tamdes_kunjungan', ['id_kunjungan' => $id])->row();
        if (!$visit || $visit->created_by !== 'whatsapp') $this->json_response(['success' => false, 'message' => 'Kunjungan tidak ditemukan'], 404);
        if ($visit->status !== 'menunggu_evaluasi') $this->json_response(['success' => false, 'message' => 'Evaluasi sudah selesai atau ditutup'], 409);

        $eval_token = $this->mint_kiosk_token('eval-submit', $id, 600); // short; used against UNCHANGED /api/evaluations/{id}
        $this->json_response(['success' => true, 'data' => ['id_kunjungan' => $id, 'kiosk_token' => $eval_token], 'message' => 'OK']);
    }

    /* ───────────────────────── private helpers ───────────────────────── */

    private function wa_dispatch_scan() {
        $now = date('Y-m-d H:i:s');

        // 1. Expire stale sessions (>48h awaiting_form).
        $this->db->where('state', 'awaiting_form')
                 ->where('created_at <', date('Y-m-d H:i:s', time() - 48 * 3600))
                 ->update('wa_sessions', ['state' => 'expired']);

        // 2. Enqueue eval_link for WA SKD visits newly menunggu_evaluasi (ledger-dedup).
        $need_eval = $this->db->query(
            "SELECT k.id_kunjungan, b.notel FROM tamdes_kunjungan k
             JOIN tamdes_buku b ON b.id_user = k.id_user
             WHERE k.created_by = 'whatsapp' AND k.status = 'menunggu_evaluasi'
               AND NOT EXISTS (SELECT 1 FROM wa_outbox o WHERE o.id_kunjungan = k.id_kunjungan AND o.msg_type = 'eval_link')"
        )->result();
        foreach ($need_eval as $v) {
            $idk = (int) $v->id_kunjungan;
            $tok = $this->mint_kiosk_token('wa-eval-access', $idk, 7 * 24 * 3600);
            $link = $this->wa_public_base() . '/evaluasi/' . $idk . '?t=' . rawurlencode($tok);
            $body = "Terima kasih telah menggunakan layanan kami. Mohon kesediaan Anda mengisi evaluasi singkat (berlaku 7 hari):\n" . $link;
            $this->db->insert('wa_outbox', ['phone_raw' => $v->notel, 'msg_type' => 'eval_link', 'body' => $body, 'id_kunjungan' => $idk, 'status' => 'pending']);
        }

        // 3. Enqueue thankyou for WA visits selesai with no eval_link and no thankyou (non-SKD path).
        $need_ty = $this->db->query(
            "SELECT k.id_kunjungan, b.notel FROM tamdes_kunjungan k
             JOIN tamdes_buku b ON b.id_user = k.id_user
             WHERE k.created_by = 'whatsapp' AND k.status = 'selesai'
               AND NOT EXISTS (SELECT 1 FROM wa_outbox o WHERE o.id_kunjungan = k.id_kunjungan AND o.msg_type = 'eval_link')
               AND NOT EXISTS (SELECT 1 FROM wa_outbox o WHERE o.id_kunjungan = k.id_kunjungan AND o.msg_type = 'thankyou')"
        )->result();
        foreach ($need_ty as $v) {
            $body = "Terima kasih telah menghubungi BPS Provinsi Maluku Utara. Permintaan Anda telah selesai kami proses.";
            $this->db->insert('wa_outbox', ['phone_raw' => $v->notel, 'msg_type' => 'thankyou', 'body' => $body, 'id_kunjungan' => (int) $v->id_kunjungan, 'status' => 'pending']);
        }

        // 4. Auto-close eval timeouts (>7d since eval_link sent, no eval rows). Idempotent: only menunggu_evaluasi rows match.
        $stale = $this->db->query(
            "SELECT k.id_kunjungan FROM tamdes_kunjungan k
             JOIN wa_outbox o ON o.id_kunjungan = k.id_kunjungan AND o.msg_type = 'eval_link'
             WHERE k.created_by = 'whatsapp' AND k.status = 'menunggu_evaluasi'
               AND o.sent_at IS NOT NULL AND o.sent_at < ?
               AND NOT EXISTS (SELECT 1 FROM tamdes_evaluasi_detail e WHERE e.id_kunjungan = k.id_kunjungan)",
            [date('Y-m-d H:i:s', time() - 7 * 24 * 3600)]
        )->result();
        foreach ($stale as $v) {
            $idk = (int) $v->id_kunjungan;
            $this->db->where('id_kunjungan', $idk)->update('tamdes_kunjungan', [
                'status' => 'selesai', 'selesai_timestamp' => $now, 'rating_pengunjung' => null,
            ]);
            $this->audit_system('auto_close_wa_eval', 'visit', $idk, ['from' => 'menunggu_evaluasi', 'to' => 'selesai']);
        }
    }

    private function wa_public_base() {
        return rtrim($this->push_config('wa_public_base') ?: 'https://bukutamu.bpsmalut.com', '/');
    }

    // audit() reads current_user->username; internal calls have no JWT user → write 'system' directly.
    private function audit_system($action, $type, $id, $detail) {
        $this->db->insert('tamdes_audit_log', [
            'admin_user'  => 'system',
            'action'      => $action,
            'target_type' => $type,
            'target_id'   => $id,
            'detail'      => $detail ? json_encode($detail) : null,
            'ip_address'  => $this->input->ip_address(),
        ]);
    }

    // New guest from WA intake (mirrors Kiosk::register guest_data, minus biometric; notel = canonical phone).
    private function wa_guest_data($id_user, $phone_norm, $input) {
        return [
            'id_user'             => $id_user,
            'nama'                => $input['nama'] ?? '',
            'email'               => $input['email'] ?? '',
            'notel'               => $phone_norm,
            'jeniskelamin'        => $input['jeniskelamin'] ?? '',
            'umur'                => !empty($input['umur']) ? (int) $input['umur'] : null,
            'disabilitas'         => !empty($input['disabilitas']) ? (int) $input['disabilitas'] : null,
            'jenis_disabilitas'   => !empty($input['jenis_disabilitas']) ? (int) $input['jenis_disabilitas'] : null,
            'pendidikan'          => $input['pendidikan'] ?? '',
            'pekerjaan'           => $input['pekerjaan'] ?? '',
            'pekerjaan_lainnya'   => $input['pekerjaan_lainnya'] ?? null,
            'kategori_instansi'   => $input['kategori_instansi'] ?? '',
            'kategori_lainnya'    => $input['kategori_lainnya'] ?? null,
            'nama_instansi'       => $input['nama_instansi'] ?? '',
            'pemanfaatan'         => $input['pemanfaatan'] ?? '',
            'pemanfaatan_lainnya' => $input['pemanfaatan_lainnya'] ?? null,
            'pengaduan'           => $input['pengaduan'] ?? '',
            'tgldatang'           => date('Y-m-d'),
            'registered_via'      => 'whatsapp',
        ];
    }

    // Progressive profiling for returning guests: only fill columns that are currently empty.
    private function wa_profile_patch($existing, $input) {
        $patch = [];
        $fields = ['nama','email','jeniskelamin','umur','pendidikan','pekerjaan','kategori_instansi','nama_instansi','pemanfaatan'];
        foreach ($fields as $f) {
            $cur = $existing->$f ?? null;
            $new = $input[$f] ?? null;
            if (($cur === null || $cur === '' || $cur === 0 || $cur === '0') && $new !== null && $new !== '') {
                $patch[$f] = in_array($f, ['umur'], true) ? (int) $new : $new;
            }
        }
        return $patch;
    }
}
