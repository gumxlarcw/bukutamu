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
        $wa_id     = trim((string) ($input['wa_id'] ?? '')); // exact WA address to reply to (@c.us or @lid)
        if ($phone_raw === '' && $wa_id === '') $this->json_response(['success' => false, 'message' => 'phone diperlukan'], 400);
        if ($phone_raw === '') $phone_raw = $wa_id;
        $phone_norm = $this->normalize_phone($phone_raw);
        $reply_to   = $wa_id !== '' ? $wa_id : $phone_raw; // never reconstruct — reply to what WA gave us

        // Active session for this phone? → continuation (bot stays silent; petugas handles
        // the chat manually). "Active" = link sent but form not submitted AND still within the
        // 48h link TTL (awaiting_form), OR submitted with a visit that is not yet 'selesai'.
        // Once the visit is 'selesai', the session is expired, its link is past 48h, or its
        // visit is deleted, the next message is a NEW request → mint a fresh link. The 48h
        // bound is what lets an expired link recover: re-messaging gets a new link, not a stale one.
        $open = $this->db->query(
            "SELECT s.id, s.state FROM wa_sessions s
             LEFT JOIN tamdes_kunjungan k ON k.id_kunjungan = s.id_kunjungan
             WHERE s.phone_norm = ?
               AND ( (s.state = 'awaiting_form' AND s.created_at > (NOW() - INTERVAL 48 HOUR))
                     OR (s.state = 'submitted' AND k.status IS NOT NULL AND k.status <> 'selesai') )
             ORDER BY s.id DESC LIMIT 1",
            [$phone_norm]
        )->row();
        if ($open) {
            $this->db->where('id', $open->id)->update('wa_sessions', ['last_inbound_at' => date('Y-m-d H:i:s'), 'wa_chat_id' => $reply_to]);
            $this->json_response(['success' => true, 'data' => ['session_id' => (int) $open->id, 'new' => false], 'message' => 'OK']);
        }

        // New session → mint link token (48h) → enqueue intake_link.
        $this->db->insert('wa_sessions', [
            'phone_norm'      => $phone_norm,
            'phone_raw'       => $phone_raw,
            'wa_chat_id'      => $reply_to,
            'state'           => 'awaiting_form',
            'last_inbound_at' => date('Y-m-d H:i:s'),
        ]);
        $sid   = (int) $this->db->insert_id();
        $token = $this->mint_kiosk_token('wa-intake', $sid, 48 * 3600);
        $link  = $this->wa_public_base() . '/layanan-online/' . $sid . '?t=' . rawurlencode($token);
        $this->db->where('id', $sid)->update('wa_sessions', ['link_sent_at' => date('Y-m-d H:i:s')]);

        $body = "Halo #SahabatData,\n\n"
              . "Terima kasih telah menghubungi BPS Provinsi Maluku Utara. Pesan ini dikirim secara otomatis. "
              . "Operator kami akan segera merespons pada jam operasional layanan: Senin s.d. Jumat pukul "
              . "08.00–15.30 WIT (selain hari libur), sesuai dengan antrian.\n\n"
              . "Untuk mempercepat layanan, mohon lengkapi formulir permintaan data Anda melalui tautan berikut "
              . "agar permintaan dapat segera kami proses (tautan berlaku 48 jam):\n" . $link . "\n\n"
              . "Terima kasih atas kepercayaan Anda menggunakan layanan kami.";
        $this->db->insert('wa_outbox', ['phone_raw' => $phone_raw, 'wa_chat_id' => $reply_to, 'msg_type' => 'intake_link', 'body' => $body, 'status' => 'pending']);

        // Heads-up ke grup petugas (kalau grup dikonfigurasi): tampilkan NOMOR + PESAN pertama.
        $g_text = trim((string) ($input['text'] ?? ''));
        $g_name = $this->wa_known_name($phone_norm);
        $g_body = "🆕 *Layanan Online — Kontak Baru*\n"
                . ($g_name ? "Nama: {$g_name}\n" : '')
                . "Nomor: {$phone_norm}\n";
        if ($g_text !== '') $g_body .= "Pesan: \"" . mb_substr($g_text, 0, 400) . "\"\n";
        $g_body .= "Tautan formulir sudah dikirim otomatis. Pantau: " . $this->wa_public_base() . "/admin/layanan-online";
        $this->wa_notify_group_enqueue($g_body);

        $this->json_response(['success' => true, 'data' => ['session_id' => $sid, 'new' => true], 'message' => 'OK']);
    }

    // POST /api/wa/poll  → idempotent dispatch scan, then return pending outbox
    public function poll() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_internal_secret();

        $this->wa_dispatch_scan();

        $pending = $this->db->where('status', 'pending')->order_by('id', 'ASC')->limit(50)->get('wa_outbox')->result();
        $messages = array_map(function ($m) {
            return ['id' => (int) $m->id, 'kind' => 'outbox', 'phone' => $m->phone_raw, 'wa_chat_id' => $m->wa_chat_id, 'body' => $m->body];
        }, $pending);

        // Chat keluar (wa_messages) — balasan petugas dari popup; teks atau media.
        $chat = $this->db->where('direction', 'out')->where('status', 'pending')
                         ->order_by('id', 'ASC')->limit(20)->get('wa_messages')->result();
        foreach ($chat as $m) {
            $messages[] = [
                'id' => (int) $m->id, 'kind' => 'chat', 'phone' => $m->phone_norm, 'wa_chat_id' => $m->wa_chat_id,
                'body' => $m->body, 'media_path' => $m->media_path, 'media_mime' => $m->media_mime, 'media_name' => $m->media_name,
            ];
        }

        // Pending admin command (read-once), e.g. 'logout' to unlink & re-scan a new number.
        $st = $this->db->get_where('wa_qr_state', ['id' => 1])->row();
        $command = $st ? $st->command : null;
        if ($command) $this->db->where('id', 1)->update('wa_qr_state', ['command' => null]);

        // Antrian backfill (histori + recovery pasca-outage) → connector fetchMessages per chat.
        $bf = $this->db->where('status', 'pending')->order_by('id', 'ASC')->limit(5)->get('wa_backfill')->result();
        $backfills = array_map(function ($b) {
            return ['id' => (int) $b->id, 'phone' => $b->phone_norm, 'wa_chat_id' => $b->wa_chat_id];
        }, $bf);

        $this->json_response(['success' => true, 'data' => ['messages' => $messages, 'command' => $command, 'backfills' => $backfills], 'message' => 'OK']);
    }

    // POST /api/wa/disconnect (auth + PST role) — admin minta connector putus tautan & tampilkan QR baru (ganti nomor).
    public function disconnect() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_auth();
        $role = $this->current_user->role ?? '';
        if (!in_array($role, ['petugas_pst', 'operator', 'admin', 'superadmin', 'pimpinan'], true)) {
            $this->json_response(['success' => false, 'message' => 'Akses ditolak.'], 403);
        }
        $this->db->where('id', 1)->update('wa_qr_state', ['command' => 'logout', 'ready' => 0, 'qr' => null, 'number' => null]);
        $this->json_response(['success' => true, 'data' => null, 'message' => 'Memutuskan koneksi… QR baru akan muncul sebentar lagi.']);
    }

    // POST /api/wa/ack  { ids:[...] }
    public function ack() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_internal_secret();

        $input = $this->get_json_input();
        $ids   = (isset($input['ids']) && is_array($input['ids'])) ? array_map('intval', $input['ids']) : [];
        $cids  = (isset($input['chat_ids']) && is_array($input['chat_ids'])) ? array_map('intval', $input['chat_ids']) : [];
        $csent = (isset($input['chat_sent']) && is_array($input['chat_sent'])) ? $input['chat_sent'] : [];
        $bids  = (isset($input['backfill_ids']) && is_array($input['backfill_ids'])) ? array_map('intval', $input['backfill_ids']) : [];
        $bfail = (isset($input['backfill_fail']) && is_array($input['backfill_fail'])) ? array_map('intval', $input['backfill_fail']) : [];
        if ($ids)  $this->db->where_in('id', $ids)->update('wa_outbox', ['status' => 'sent', 'sent_at' => date('Y-m-d H:i:s')]);
        if ($cids) $this->db->where_in('id', $cids)->where('direction', 'out')->update('wa_messages', ['status' => 'sent']);
        // Chat keluar terkirim → simpan WA message-id-nya supaya backfill/recovery TIDAK menggandakan pesan kita sendiri.
        foreach ($csent as $cs) {
            $cid = (int) ($cs['id'] ?? 0);
            $wid = trim((string) ($cs['wa_msg_id'] ?? ''));
            if (!$cid) continue;
            $upd = ['status' => 'sent'];
            if ($wid !== '') $upd['wa_msg_id'] = $wid;
            $this->db->where('id', $cid)->where('direction', 'out')->update('wa_messages', $upd);
        }
        if ($bids) $this->db->where_in('id', $bids)->update('wa_backfill', ['status' => 'done']);
        // Backfill GAGAL (getChatById/fetchMessages error) → naikkan attempts, retry di poll
        // berikutnya; menyerah (done) setelah 4 percobaan agar tak loop selamanya.
        if ($bfail) {
            $this->db->where_in('id', $bfail)->set('attempts', 'attempts+1', false)->update('wa_backfill');
            $this->db->where_in('id', $bfail)->where('attempts >=', 4)->update('wa_backfill', ['status' => 'done']);
        }
        $this->json_response(['success' => true, 'data' => ['acked' => count($ids) + count($cids) + count($csent)], 'message' => 'OK']);
    }

    /* ───────────────────────── live chat (web petugas ↔ WhatsApp) ───────────────────────── */

    // POST /api/wa/chat-ingest — connector menyimpan pesan MASUK (internal-secret).
    // Connector sudah menulis media ke wa_media/ (disk yang sama) → terima BASENAME, bukan base64.
    public function chat_ingest() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_internal_secret();

        $in         = $this->get_json_input();
        $phone_raw  = trim((string) ($in['phone'] ?? ''));
        $wa_chat_id = trim((string) ($in['wa_chat_id'] ?? ''));
        $wa_msg_id  = trim((string) ($in['wa_msg_id'] ?? ''));
        if ($phone_raw === '' || $wa_chat_id === '') $this->json_response(['success' => false, 'message' => 'phone/wa_chat_id diperlukan'], 400);
        $phone_norm = $this->normalize_phone($phone_raw);
        $from_me    = !empty($in['from_me']);                  // backfill: pesan dari kita (out)
        $ts         = isset($in['ts']) ? (int) $in['ts'] : 0;  // backfill: timestamp asli (unix detik)
        $backfill   = !empty($in['backfill']);                 // backfill (petugas minta histori) → lewati guard sesi-aktif

        // Live inbound: hanya simpan untuk kontak dengan sesi aktif (cegah spam non-sesi).
        // Backfill: pakai sesi terbaru sebagai konteks (petugas yang minta histori).
        $sess = $backfill ? $this->wa_latest_session($phone_norm) : $this->wa_active_session($phone_norm);
        if (!$sess) $this->json_response(['success' => true, 'data' => ['stored' => false], 'message' => 'no session']);

        // Dedup by WhatsApp message id (connector boleh kirim ulang).
        if ($wa_msg_id !== '') {
            $dup = $this->db->select('id')->where('wa_msg_id', $wa_msg_id)->limit(1)->get('wa_messages')->row();
            if ($dup) $this->json_response(['success' => true, 'data' => ['stored' => false, 'id' => (int) $dup->id], 'message' => 'duplicate']);
        }

        $type = in_array(($in['type'] ?? 'text'), ['text', 'image', 'document'], true) ? $in['type'] : 'text';
        $body = isset($in['body']) ? mb_substr((string) $in['body'], 0, 8000) : null;

        // Backfill re-ingest of OUR OWN outbound message: the live send path already recorded it,
        // but WhatsApp @lid history can serialize wa_msg_id DIFFERENTLY than sendMessage returned
        // (and the live id may not be persisted yet when backfill runs in the same tick), so the
        // wa_msg_id dedup above misses → a phantom duplicate row. Dedup by content for our own
        // historical text messages. Text only: an existing out row with the same body means the
        // app already has it; media keeps wa_msg_id dedup (caption bodies are not unique enough).
        if ($backfill && $from_me && $type === 'text' && $body !== null && $body !== '') {
            $dup = $this->db->select('id')->where('phone_norm', $phone_norm)
                            ->where('direction', 'out')->where('body', $body)
                            ->limit(1)->get('wa_messages')->row();
            if ($dup) $this->json_response(['success' => true, 'data' => ['stored' => false, 'id' => (int) $dup->id], 'message' => 'duplicate (content)']);
        }

        $media_path = null; $media_mime = null; $media_name = null;
        if ($type !== 'text') {
            $base = basename((string) ($in['media_path'] ?? '')); // buang komponen path apa pun
            if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.[A-Za-z0-9]{1,8}$/', $base)) {
                $this->json_response(['success' => false, 'message' => 'media_path tidak valid'], 422);
            }
            $real = realpath($this->wa_media_dir() . $base);
            if ($real === false || strpos($real, realpath($this->wa_media_dir())) !== 0 || !is_file($real)) {
                $this->json_response(['success' => false, 'message' => 'file media tidak ditemukan'], 422);
            }
            if (filesize($real) > 25 * 1024 * 1024) { @unlink($real); $this->json_response(['success' => false, 'message' => 'media melebihi 25MB'], 422); }
            $mime = $this->wa_detect_mime($real, ''); // finfo authoritative; fail-closed (jangan percaya hint klien)
            if (!$this->wa_mime_allowed($mime)) { @unlink($real); $this->json_response(['success' => false, 'message' => 'tipe file tidak diizinkan'], 422); }
            $media_path = $base;
            $media_mime = $mime;
            $media_name = isset($in['media_name']) ? mb_substr((string) $in['media_name'], 0, 200) : $base;
            $type = (strpos($mime, 'image/') === 0) ? 'image' : 'document';
        }

        $row = [
            'phone_norm'   => $phone_norm,
            'wa_chat_id'   => $wa_chat_id,
            'id_kunjungan' => $sess->id_kunjungan ?: null,
            'direction'    => $from_me ? 'out' : 'in',
            'msg_type'     => $type,
            'body'         => $body,
            'media_path'   => $media_path,
            'media_mime'   => $media_mime,
            'media_name'   => $media_name,
            'wa_msg_id'    => ($wa_msg_id !== '' ? $wa_msg_id : null),
            'status'       => $from_me ? 'sent' : 'received',
        ];
        if ($ts > 0) $row['created_at'] = date('Y-m-d H:i:s', $ts); // backfill: pertahankan waktu asli pesan
        $ok = $this->db->insert('wa_messages', $row);
        if ($ok === false) { // db_debug off → insert bisa gagal diam-diam; jangan klaim tersimpan + bersihkan media
            if ($media_path) @unlink($this->wa_media_dir() . $media_path);
            $this->json_response(['success' => false, 'message' => 'gagal menyimpan pesan'], 500);
        }
        $this->json_response(['success' => true, 'data' => ['stored' => true, 'id' => (int) $this->db->insert_id()], 'message' => 'OK']);
    }

    // GET /api/wa/messages?phone=&after=  → thread (auth + PST role).
    // POST /api/wa/messages {phone, body} → enqueue teks keluar (rate-limited).
    public function messages() {
        $this->require_auth();
        if (!$this->wa_is_pst_role()) $this->json_response(['success' => false, 'message' => 'Akses ditolak.'], 403);

        if ($_SERVER['REQUEST_METHOD'] === 'GET') {
            $phone = $this->normalize_phone((string) $this->input->get('phone'));
            $after = (int) $this->input->get('after');
            if ($phone === '') $this->json_response(['success' => false, 'message' => 'phone diperlukan'], 400);
            $rows = $this->db->where('phone_norm', $phone)->where('id >', $after)
                             ->order_by('id', 'ASC')->limit(500)->get('wa_messages')->result();
            $this->json_response(['success' => true, 'data' => array_map([$this, 'wa_msg_public'], $rows), 'message' => 'OK']);
        }

        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $this->require_rate_limit('wa/chat', 15);
            $in    = $this->get_json_input();
            $phone = $this->normalize_phone((string) ($in['phone'] ?? ''));
            $body  = trim((string) ($in['body'] ?? ''));
            if ($phone === '' || $body === '') $this->json_response(['success' => false, 'message' => 'phone & body diperlukan'], 422);
            if (mb_strlen($body) > 4096) $this->json_response(['success' => false, 'message' => 'Pesan maksimal 4096 karakter'], 422);
            $sess = $this->wa_latest_session($phone);
            if (!$sess || !$sess->wa_chat_id) $this->json_response(['success' => false, 'message' => 'Kontak tidak ditemukan'], 404);
            $this->db->insert('wa_messages', [
                'phone_norm'   => $phone,
                'wa_chat_id'   => $sess->wa_chat_id,
                'id_kunjungan' => $sess->id_kunjungan ?: null,
                'direction'    => 'out',
                'msg_type'     => 'text',
                'body'         => $body,
                'status'       => 'pending',
            ]);
            $id = (int) $this->db->insert_id();
            $this->audit_system('wa_chat_send', 'message', $id, ['type' => 'text']);
            $this->json_response(['success' => true, 'data' => $this->wa_msg_public($this->db->get_where('wa_messages', ['id' => $id])->row()), 'message' => 'OK']);
        }

        $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
    }

    // POST /api/wa/messages/upload (multipart: phone, file, caption?) — kirim media keluar.
    public function messages_upload() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_auth();
        if (!$this->wa_is_pst_role()) $this->json_response(['success' => false, 'message' => 'Akses ditolak.'], 403);
        $this->require_rate_limit('wa/chat-upload', 6);

        $phone   = $this->normalize_phone((string) $this->input->post('phone'));
        $caption = trim((string) $this->input->post('caption'));
        if ($phone === '') $this->json_response(['success' => false, 'message' => 'phone diperlukan'], 422);
        if (empty($_FILES['file']) || ($_FILES['file']['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            $this->json_response(['success' => false, 'message' => 'File tidak ada atau gagal upload'], 422);
        }
        $f = $_FILES['file'];
        if ($f['size'] > 25 * 1024 * 1024) $this->json_response(['success' => false, 'message' => 'File melebihi 25MB'], 422);
        $mime = $this->wa_detect_mime($f['tmp_name'], ''); // finfo authoritative; fail-closed (jangan percaya $_FILES type)
        if (!$this->wa_mime_allowed($mime)) $this->json_response(['success' => false, 'message' => 'Tipe file tidak diizinkan'], 422);

        $sess = $this->wa_latest_session($phone);
        if (!$sess || !$sess->wa_chat_id) $this->json_response(['success' => false, 'message' => 'Kontak tidak ditemukan'], 404);

        $name = bin2hex(random_bytes(16)) . '.' . $this->wa_ext_for_mime($mime);
        $dest = $this->wa_media_dir() . $name;
        if (!move_uploaded_file($f['tmp_name'], $dest)) $this->json_response(['success' => false, 'message' => 'Gagal menyimpan file'], 500);
        @chmod($dest, 0644);
        $type = (strpos($mime, 'image/') === 0) ? 'image' : 'document';

        $ins = $this->db->insert('wa_messages', [
            'phone_norm'   => $phone,
            'wa_chat_id'   => $sess->wa_chat_id,
            'id_kunjungan' => $sess->id_kunjungan ?: null,
            'direction'    => 'out',
            'msg_type'     => $type,
            'body'         => ($caption !== '' ? mb_substr($caption, 0, 1024) : null),
            'media_path'   => $name,
            'media_mime'   => $mime,
            'media_name'   => mb_substr((string) ($f['name'] ?? $name), 0, 200),
            'status'       => 'pending',
        ]);
        if ($ins === false) { @unlink($dest); $this->json_response(['success' => false, 'message' => 'Gagal menyimpan pesan'], 500); }
        $id = (int) $this->db->insert_id();
        $this->audit_system('wa_chat_send', 'message', $id, ['type' => $type, 'mime' => $mime]);
        $this->json_response(['success' => true, 'data' => $this->wa_msg_public($this->db->get_where('wa_messages', ['id' => $id])->row()), 'message' => 'OK']);
    }

    // GET /api/wa/media/(:num) — stream media tersimpan (auth + PST role).
    public function media($id) {
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_auth();
        if (!$this->wa_is_pst_role()) $this->json_response(['success' => false, 'message' => 'Akses ditolak.'], 403);

        $m = $this->db->get_where('wa_messages', ['id' => (int) $id])->row();
        if (!$m || !$m->media_path) $this->json_response(['success' => false, 'message' => 'Tidak ditemukan'], 404);
        $real = realpath($this->wa_media_dir() . basename($m->media_path));
        if ($real === false || strpos($real, realpath($this->wa_media_dir())) !== 0 || !is_file($real)) {
            $this->json_response(['success' => false, 'message' => 'File tidak ada'], 404);
        }
        $mime  = $m->media_mime ?: 'application/octet-stream';
        $disp  = (strpos($mime, 'image/') === 0) ? 'inline' : 'attachment';
        $fname = str_replace(['"', "\r", "\n", '/', '\\'], '', ($m->media_name ?: basename($real)));
        while (ob_get_level() > 0) ob_end_clean();
        header('Content-Type: ' . $mime);
        header('Content-Length: ' . filesize($real));
        header('Content-Disposition: ' . $disp . '; filename="' . $fname . '"');
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: private, max-age=300');
        readfile($real);
        exit;
    }

    // POST /api/wa/messages/fail {ids:[...]} — connector tandai pesan keluar gagal (internal-secret).
    public function messages_fail() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_internal_secret();
        $in  = $this->get_json_input();
        $ids = (isset($in['ids']) && is_array($in['ids'])) ? array_map('intval', $in['ids']) : [];
        if ($ids) $this->db->where_in('id', $ids)->where('direction', 'out')->update('wa_messages', ['status' => 'failed']);
        $this->json_response(['success' => true, 'data' => null, 'message' => 'OK']);
    }

    // POST /api/wa/messages/backfill {phone} — petugas minta histori chat (auth + PST role).
    // Antri-kan; connector fetchMessages dari WhatsApp lalu ingest (dedup by wa_msg_id). Throttle 5 menit.
    public function messages_backfill() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_auth();
        if (!$this->wa_is_pst_role()) $this->json_response(['success' => false, 'message' => 'Akses ditolak.'], 403);
        $in    = $this->get_json_input();
        $phone = $this->normalize_phone((string) ($in['phone'] ?? ''));
        if ($phone === '') $this->json_response(['success' => false, 'message' => 'phone diperlukan'], 422);
        $sess = $this->wa_latest_session($phone);
        if (!$sess || !$sess->wa_chat_id) $this->json_response(['success' => false, 'message' => 'Kontak tidak ditemukan'], 404);
        // Throttle: lewati kalau sudah ada permintaan backfill utk nomor ini dalam 5 menit terakhir.
        $recent = $this->db->where('phone_norm', $phone)
                           ->where('created_at >=', date('Y-m-d H:i:s', time() - 300))
                           ->count_all_results('wa_backfill');
        $queued = false;
        if ($recent == 0) {
            $this->db->insert('wa_backfill', ['phone_norm' => $phone, 'wa_chat_id' => $sess->wa_chat_id, 'status' => 'pending']);
            $queued = true;
        }
        $this->json_response(['success' => true, 'data' => ['queued' => $queued], 'message' => 'OK']);
    }

    // POST /api/wa/backfill-active — connector saat 'ready' (reconnect) minta backfill SEMUA sesi
    // aktif → recovery pesan yang mungkin terlewat saat server/internet mati (internal-secret).
    public function backfill_active() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_internal_secret();
        $rows = $this->db->query(
            "SELECT s.phone_norm, MAX(s.wa_chat_id) AS wa_chat_id FROM wa_sessions s
             LEFT JOIN tamdes_kunjungan k ON k.id_kunjungan = s.id_kunjungan
             WHERE s.wa_chat_id IS NOT NULL
               AND ( (s.state = 'awaiting_form' AND s.created_at > (NOW() - INTERVAL 48 HOUR))
                     OR (s.state = 'submitted' AND k.status IS NOT NULL AND k.status <> 'selesai') )
             GROUP BY s.phone_norm"
        )->result();
        $n = 0;
        foreach ($rows as $r) {
            $p = $this->db->where('phone_norm', $r->phone_norm)->where('status', 'pending')->count_all_results('wa_backfill');
            if ($p == 0) {
                $this->db->insert('wa_backfill', ['phone_norm' => $r->phone_norm, 'wa_chat_id' => $r->wa_chat_id, 'status' => 'pending']);
                $n++;
            }
        }
        $this->json_response(['success' => true, 'data' => ['queued' => $n], 'message' => 'OK']);
    }

    // DELETE /api/wa/sessions/(:num) — admin (real admin/superadmin): hapus sesi PENDING dari
    // inbox Layanan Online + bersihkan data terkait nomornya. Sesi yang sudah jadi kunjungan
    // dihapus lewat DELETE /api/visits/{id} (cascade kunjungan yang benar).
    public function session_delete($id) {
        if ($_SERVER['REQUEST_METHOD'] !== 'DELETE') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_auth();
        $this->require_role('admin');
        $id   = (int) $id;
        $sess = $this->db->get_where('wa_sessions', ['id' => $id])->row();
        if (!$sess) $this->json_response(['success' => false, 'message' => 'Sesi tidak ditemukan'], 404);
        if ($sess->id_kunjungan) {
            $this->json_response(['success' => false, 'message' => 'Sesi ini sudah menjadi kunjungan — hapus melalui daftar kunjungan.'], 409);
        }
        $phone = $sess->phone_norm;
        $this->db->where('id', $id)->delete('wa_sessions');
        $this->db->where('phone_norm', $phone)->delete('wa_backfill');
        // Hapus chat hanya bila nomor ini tak punya sesi lain yang sudah menjadi kunjungan
        // (jaga agar chat kunjungan aktif milik nomor yang sama tidak ikut terhapus).
        $other = $this->db->where('phone_norm', $phone)->where('id_kunjungan IS NOT NULL', null, false)->count_all_results('wa_sessions');
        if ($other == 0) $this->db->where('phone_norm', $phone)->delete('wa_messages');
        $this->audit('delete', 'wa_session', $id, ['phone' => $phone]);
        $this->json_response(['success' => true, 'data' => null, 'message' => 'Sesi dihapus']);
    }

    // POST /api/wa/visits/(:num)/proses — tandai visit WA sedang dikerjakan saat petugas
    // membuka popup "Proses" (antri/dipanggil → diproses). Idempoten; tak men-downgrade
    // status yang sudah lebih lanjut (diproses/menunggu_evaluasi/selesai).
    public function visit_proses($id) {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_auth();
        if (!$this->wa_is_pst_role()) $this->json_response(['success' => false, 'message' => 'Akses ditolak.'], 403);
        $id = (int) $id;
        $v = $this->db->select('status')->get_where('tamdes_kunjungan', ['id_kunjungan' => $id])->row();
        if (!$v) $this->json_response(['success' => false, 'message' => 'Kunjungan tidak ditemukan'], 404);
        if (in_array($v->status, ['antri', 'dipanggil'], true)) {
            $this->db->where('id_kunjungan', $id)->update('tamdes_kunjungan', ['status' => 'diproses']);
        }
        $this->json_response(['success' => true, 'data' => ['status' => 'diproses'], 'message' => 'OK']);
    }

    // POST /api/wa/visits/(:num)/selesai — operator menutup sesi WA secara manual
    // (evaluasi_selesai → selesai) + kirim pesan penutup. (auth + PST role)
    public function visit_selesai($id) {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_auth();
        if (!$this->wa_is_pst_role()) $this->json_response(['success' => false, 'message' => 'Akses ditolak.'], 403);
        $id = (int) $id;
        $v = $this->db->select('status, created_by')->get_where('tamdes_kunjungan', ['id_kunjungan' => $id])->row();
        if (!$v || $v->created_by !== 'whatsapp') $this->json_response(['success' => false, 'message' => 'Kunjungan tidak ditemukan'], 404);
        if ($v->status === 'selesai') {
            $this->json_response(['success' => true, 'data' => ['status' => 'selesai'], 'message' => 'Sudah selesai']);
        }
        if ($v->status !== 'evaluasi_selesai') {
            $this->json_response(['success' => false, 'message' => 'Belum bisa diselesaikan — evaluasi belum diisi pengunjung.'], 409);
        }
        $this->db->where('id_kunjungan', $id)->update('tamdes_kunjungan', ['status' => 'selesai']);
        $this->wa_closing_enqueue($id);
        $this->audit('wa_close', 'visit', $id, ['from' => 'evaluasi_selesai', 'to' => 'selesai']);
        $this->json_response(['success' => true, 'data' => ['status' => 'selesai'], 'message' => 'Sesi ditutup & pesan penutup dikirim']);
    }

    /* ───────────────────────── admin (Layanan Online inbox) ───────────────────────── */

    // GET /api/wa/inbox  — WA visits with guest + request summary
    public function inbox() {
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_auth();

        // Same role gate as the FE sidebar (PST_DTSEN_ROLES): WA requests are SKD-type,
        // handled by petugas PST. resepsionis (front-office) must NOT see the WA guest
        // dataset — require_auth() alone would let any logged-in role read it.
        $role = $this->current_user->role ?? '';
        if (!in_array($role, ['petugas_pst', 'operator', 'admin', 'superadmin', 'pimpinan'], true)) {
            $this->json_response(['success' => false, 'message' => 'Akses ditolak.'], 403);
        }

        // 1) Visit yang sudah submit form (punya kunjungan).
        $visits = $this->db
            ->select('k.id_kunjungan, k.status, k.date_visit AS dt, b.nama, b.nama_instansi, b.notel')
            ->select("(SELECT GROUP_CONCAT(kp.rincian_data SEPARATOR ' · ') FROM konsultasi_pengunjung kp WHERE kp.id_kunjungan = k.id_kunjungan) AS permintaan", FALSE)
            ->from('tamdes_kunjungan k')
            ->join('tamdes_buku b', 'k.id_user = b.id_user', 'left')
            ->where('k.created_by', 'whatsapp')
            ->order_by('k.id_kunjungan', 'DESC')
            ->limit(200)
            ->get()->result();

        $items = [];
        foreach ($visits as $v) {
            $items[] = [
                'kind'          => 'visit',
                'id_kunjungan'  => (int) $v->id_kunjungan,
                'session_id'    => null,
                'status'        => $v->status,
                'date'          => $v->dt,
                'nama'          => $v->nama,
                'nama_instansi' => $v->nama_instansi,
                'notel'         => $v->notel,
                'permintaan'    => $v->permintaan,
            ];
        }

        // 2) Sesi yang sudah dikirimi link tapi BELUM mengisi form (awaiting_form).
        $pend = $this->db->select('id, phone_norm, last_inbound_at, link_sent_at, created_at')
                         ->where('state', 'awaiting_form')
                         ->order_by('id', 'DESC')->limit(100)->get('wa_sessions')->result();
        foreach ($pend as $s) {
            $items[] = [
                'kind'          => 'pending',
                'id_kunjungan'  => null,
                'session_id'    => (int) $s->id,
                'status'        => 'menunggu_form',
                'date'          => $s->last_inbound_at ?: ($s->link_sent_at ?: $s->created_at),
                'nama'          => $this->wa_known_name($s->phone_norm),
                'nama_instansi' => null,
                'notel'         => $s->phone_norm,
                'permintaan'    => null,
            ];
        }

        // Urutkan gabungan berdasarkan aktivitas terbaru.
        usort($items, function ($a, $b) { return strcmp((string) $b['date'], (string) $a['date']); });

        $this->json_response(['success' => true, 'data' => $items, 'message' => 'OK']);
    }

    /* ───────────────────────── public, kiosk-token guarded (requester browser) ───────────────────────── */

    // GET prefill / POST submit : /api/wa/session/(:num)
    public function session($id) {
        $id = (int) $id;
        $this->require_kiosk_token('wa-intake', $id);

        $sess = $this->db->get_where('wa_sessions', ['id' => $id])->row();
        if (!$sess) $this->json_response(['success' => false, 'message' => 'Sesi tidak ditemukan'], 404);

        if ($_SERVER['REQUEST_METHOD'] === 'GET') {
            // Prefill is gated only by phone possession (the token is bound to a session
            // created from an inbound message). So NEVER echo high-sensitivity or biometric
            // PII — select ONLY low-sensitivity demographic convenience fields (no email,
            // no notel, no foto, no face_descriptor). And on a multi-match (shared or
            // reassigned number, incl. known duplicate notel), return NO guest — a blank
            // form — so one person's profile is never shown to another.
            $cols = 'id_user, nama, jeniskelamin, umur, pendidikan, pekerjaan, kategori_instansi, nama_instansi, pemanfaatan';
            $matches = $this->db->select($cols)->where('notel', $sess->phone_norm)
                                ->order_by('id_user', 'DESC')->get('tamdes_buku')->result();
            $guest = (count($matches) === 1) ? $matches[0] : null;
            $multi = count($matches) > 1;
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

            // Validasi wajib server-side — FE meng-disable tombol, tapi API bisa dipanggil
            // langsung. Tamu baru tanpa nama = data sampah; tolak di boundary.
            if (trim((string) ($input['nama'] ?? '')) === '') {
                $this->json_response(['success' => false, 'message' => 'Nama wajib diisi'], 422);
            }

            // SERVER-AUTHORITATIVE — never trust client for these (R8, D2/D3/D5).
            $jenis_layanan = ['Konsultasi Statistik'];
            $sarana        = [2];
            $this->validate_no_cross_layanan($jenis_layanan);
            $this->validate_sarana_for_layanan($jenis_layanan, $sarana);

            // Guest upsert by phone (LOCK pattern from Kiosk::register). wa_sessions ikut
            // dikunci & dicek-ulang DI DALAM lock: double-submit (TOCTOU) tidak boleh membuat
            // kunjungan ganda — hanya request pertama lolos, sisanya kembalikan tiket lama.
            $this->db->query('LOCK TABLES tamdes_buku WRITE, tamdes_kunjungan WRITE, tamdes_responden_tahunan WRITE, wa_sessions WRITE');
            $fresh = $this->db->get_where('wa_sessions', ['id' => $id])->row();
            if ($fresh && $fresh->state === 'submitted' && $fresh->id_kunjungan) {
                $this->db->query('UNLOCK TABLES');
                $this->json_response(['success' => true, 'data' => ['id_kunjungan' => (int) $fresh->id_kunjungan, 'ticket' => 'WA-' . $fresh->id_kunjungan], 'message' => 'Sudah dikirim']);
            }
            $existing = $this->db->where('notel', $sess->phone_norm)->order_by('id_user', 'DESC')->limit(1)->get('tamdes_buku')->row();
            if ($existing) {
                $id_user = (int) $existing->id_user;
                $force   = !empty($input['update_profile']);           // "Perbarui Profil" → timpa; selain itu isi yang kosong saja
                $patch   = $this->wa_profile_patch($existing, $input, $force);
                if ($patch) {
                    $ok = $this->db->where('id_user', $id_user)->update('tamdes_buku', $patch);
                    if ($ok === false) { $this->db->query('UNLOCK TABLES'); $this->json_response(['success' => false, 'message' => 'Gagal memperbarui profil'], 500); }
                }
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

            // Tandai sesi submitted DI DALAM lock (sebelum UNLOCK) agar request kedua yang
            // menunggu lock melihat state terbaru dan tidak membuat kunjungan kedua.
            $this->db->where('id', $id)->update('wa_sessions', ['state' => 'submitted', 'id_kunjungan' => $id_kunjungan, 'submitted_at' => date('Y-m-d H:i:s')]);
            $this->db->query('UNLOCK TABLES');

            // Permintaan Data rows (Block B) → konsultasi_pengunjung (D4) + ringkasan utk balasan.
            $level_labels   = [1 => 'Nasional', 2 => 'Provinsi', 3 => 'Kabupaten/Kota', 4 => 'Kecamatan', 5 => 'Desa/Kelurahan', 6 => 'Individu', 7 => 'Lainnya'];
            $periode_labels = [1 => 'Sepuluh Tahunan', 2 => 'Lima Tahunan', 3 => 'Tiga Tahunan', 4 => 'Tahunan', 5 => 'Semesteran', 6 => 'Triwulanan', 7 => 'Bulanan', 8 => 'Mingguan', 9 => 'Harian', 10 => 'Lainnya'];
            $rows = (isset($input['permintaan']) && is_array($input['permintaan'])) ? $input['permintaan'] : [];
            $inserted = 0;
            $recap = '';
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

                // Ringkasan untuk balasan konfirmasi — perlihatkan persis apa yang diminta user.
                $recap .= "\n{$inserted}. {$rincian}";
                $lvl = !empty($r['level_data']) ? ($level_labels[(int) $r['level_data']] ?? '') : '';
                $wil = trim((string) ($r['wilayah_data'] ?? ''));
                $cakupan = trim($lvl . (($lvl !== '' && $wil !== '') ? ' – ' : '') . $wil);
                if ($cakupan !== '') $recap .= "\n   • Cakupan: {$cakupan}";
                if (!empty($r['periode_data']) && isset($periode_labels[(int) $r['periode_data']])) {
                    $recap .= "\n   • Periode: " . $periode_labels[(int) $r['periode_data']];
                }
                $ta = !empty($r['tahun_awal'])  ? (int) $r['tahun_awal']  : 0;
                $tb = !empty($r['tahun_akhir']) ? (int) $r['tahun_akhir'] : 0;
                if ($ta && $tb)  $recap .= "\n   • Tahun: {$ta}–{$tb}";
                elseif ($ta)     $recap .= "\n   • Tahun: {$ta}";
                elseif ($tb)     $recap .= "\n   • Tahun: {$tb}";
            }

            $this->audit_system('create_wa', 'visit', $id_kunjungan, ['id_user' => $id_user, 'konsultasi_rows' => $inserted]);

            $body = "Terima kasih, permintaan data Anda telah kami terima.\nNomor tiket: WA-{$id_kunjungan}.\n";
            if ($recap !== '') $body .= "\nRingkasan permintaan Anda:{$recap}\n";
            $body .= "\nKami akan memproses permintaan ini pada jam operasional layanan (Senin–Jumat 08.00–15.30 WIT).";
            $this->db->insert('wa_outbox', ['phone_raw' => $sess->phone_raw, 'wa_chat_id' => $sess->wa_chat_id, 'msg_type' => 'confirmation', 'body' => $body, 'id_kunjungan' => $id_kunjungan, 'status' => 'pending']);

            // Notif ke grup petugas: permintaan lengkap siap diproses (kalau grup dikonfigurasi).
            $g_nama = trim((string) ($input['nama'] ?? '')) ?: 'Pemohon';
            $g_inst = trim((string) ($input['nama_instansi'] ?? ''));
            $g_body = "✅ *Permintaan Data Online Masuk*\nTiket: WA-{$id_kunjungan}\nNama: {$g_nama}" . ($g_inst !== '' ? " ({$g_inst})" : '') . "\nNomor: {$sess->phone_norm}\n";
            if ($recap !== '') $g_body .= "Permintaan:{$recap}\n";
            $g_body .= "Mohon diproses: " . $this->wa_public_base() . "/admin/layanan-online";
            $this->wa_notify_group_enqueue($g_body);

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

    // /api/wa/qr-state — POST (internal-secret): connector pushes {qr?, ready, number?}.
    //                     GET  (auth + PST role): admin "Layanan Online" page reads it.
    // Lets the QR live behind the authenticated admin page instead of an exposed port.
    public function qr_state() {
        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $this->require_internal_secret();
            $in  = $this->get_json_input();
            $upd = ['updated_at' => date('Y-m-d H:i:s')];
            if (array_key_exists('ready', $in))        $upd['ready']        = !empty($in['ready']) ? 1 : 0;
            if (array_key_exists('number', $in))       $upd['number']       = $in['number'];
            if (array_key_exists('qr', $in))           $upd['qr']           = $in['qr']; // data-URL, or null to clear
            if (array_key_exists('pairing_code', $in)) $upd['pairing_code'] = $in['pairing_code'];
            $this->db->where('id', 1)->update('wa_qr_state', $upd);
            // Balikkan pair_phone ke connector → kalau ada, connector minta pairing code utk nomor itu.
            $st = $this->db->select('pair_phone')->get_where('wa_qr_state', ['id' => 1])->row();
            $this->json_response(['success' => true, 'data' => ['pair_phone' => ($st ? $st->pair_phone : null)], 'message' => 'OK']);
        }

        if ($_SERVER['REQUEST_METHOD'] === 'GET') {
            $this->require_auth();
            if (!$this->wa_is_pst_role()) $this->json_response(['success' => false, 'message' => 'Akses ditolak.'], 403);
            $row = $this->db->get_where('wa_qr_state', ['id' => 1])->row();
            // Liveness via freshness: connector berdetak (POST qr-state) tiap ~10s. Bila updated_at
            // basi (> TTL), connector dianggap MATI walau kolom ready masih 1 — inilah yang dulu
            // menyembunyikan outage 36 jam (ready=1 beku sejak 4 Jun). Single source of truth di
            // server (tanpa clock-skew FE). TTL harus jauh di atas pollIntervalMs (10s).
            $STALE_TTL = 60;
            $secsSince = ($row && $row->updated_at) ? (time() - strtotime($row->updated_at)) : null;
            $stale     = ($secsSince === null) ? true : ($secsSince > $STALE_TTL);
            $readyRaw  = $row ? ((int) $row->ready === 1) : false;
            $ready     = $readyRaw && !$stale; // turunkan ke offline saat basi → UI tak bisa bohong "online"
            $this->json_response(['success' => true, 'data' => [
                'ready'         => $ready,
                'qr'            => ($row && !$readyRaw) ? $row->qr : null, // only expose QR while unlinked
                'number'        => $row ? $row->number : null,
                'pair_phone'    => ($row && !$readyRaw) ? $row->pair_phone : null,
                'pairing_code'  => ($row && !$readyRaw) ? $row->pairing_code : null,
                'updated_at'    => $row ? $row->updated_at : null,
                'stale'         => $stale,
                'seconds_since' => $secsSince,
            ], 'message' => 'OK']);
        }

        $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
    }

    // POST /api/wa/pair {phone} — minta tautkan connector via NOMOR HP (pairing code, alternatif QR).
    // phone kosong = batalkan & kembali ke mode QR. (auth + PST role)
    public function pair() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_auth();
        if (!$this->wa_is_pst_role()) $this->json_response(['success' => false, 'message' => 'Akses ditolak.'], 403);
        $in  = $this->get_json_input();
        $raw = preg_replace('/\D/', '', (string) ($in['phone'] ?? ''));
        if ($raw !== '' && strpos($raw, '0') === 0) $raw = '62' . substr($raw, 1); // 08xx → 628xx (internasional)
        $this->db->where('id', 1)->update('wa_qr_state', ['pair_phone' => ($raw !== '' ? $raw : null), 'pairing_code' => null]);
        $this->json_response(['success' => true, 'data' => ['pair_phone' => ($raw !== '' ? $raw : null)], 'message' => ($raw !== '' ? 'Meminta kode tautan…' : 'Dibatalkan')]);
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
            "SELECT k.id_kunjungan, b.notel,
                    (SELECT s.wa_chat_id FROM wa_sessions s WHERE s.id_kunjungan = k.id_kunjungan ORDER BY s.id DESC LIMIT 1) AS wa_chat_id
             FROM tamdes_kunjungan k
             JOIN tamdes_buku b ON b.id_user = k.id_user
             WHERE k.created_by = 'whatsapp' AND k.status = 'menunggu_evaluasi'
               AND NOT EXISTS (SELECT 1 FROM wa_outbox o WHERE o.id_kunjungan = k.id_kunjungan AND o.msg_type = 'eval_link')"
        )->result();
        foreach ($need_eval as $v) {
            $idk = (int) $v->id_kunjungan;
            $tok = $this->mint_kiosk_token('wa-eval-access', $idk, 7 * 24 * 3600);
            $link = $this->wa_public_base() . '/evaluasi/' . $idk . '?t=' . rawurlencode($tok);
            $body = "Terima kasih telah menggunakan layanan kami. Mohon kesediaan Anda mengisi evaluasi singkat (berlaku 7 hari):\n" . $link;
            $this->db->insert('wa_outbox', ['phone_raw' => $v->notel, 'wa_chat_id' => ($v->wa_chat_id ?: $v->notel), 'msg_type' => 'eval_link', 'body' => $body, 'id_kunjungan' => $idk, 'status' => 'pending']);
        }

        // 3. Enqueue thankyou for WA visits selesai with no eval_link and no thankyou (non-SKD path).
        $need_ty = $this->db->query(
            "SELECT k.id_kunjungan, b.notel,
                    (SELECT s.wa_chat_id FROM wa_sessions s WHERE s.id_kunjungan = k.id_kunjungan ORDER BY s.id DESC LIMIT 1) AS wa_chat_id
             FROM tamdes_kunjungan k
             JOIN tamdes_buku b ON b.id_user = k.id_user
             WHERE k.created_by = 'whatsapp' AND k.status = 'selesai'
               AND NOT EXISTS (SELECT 1 FROM wa_outbox o WHERE o.id_kunjungan = k.id_kunjungan AND o.msg_type = 'eval_link')
               AND NOT EXISTS (SELECT 1 FROM wa_outbox o WHERE o.id_kunjungan = k.id_kunjungan AND o.msg_type = 'thankyou')"
        )->result();
        foreach ($need_ty as $v) {
            $body = "Terima kasih telah menghubungi BPS Provinsi Maluku Utara. Permintaan Anda telah selesai kami proses.";
            $this->db->insert('wa_outbox', ['phone_raw' => $v->notel, 'wa_chat_id' => ($v->wa_chat_id ?: $v->notel), 'msg_type' => 'thankyou', 'body' => $body, 'id_kunjungan' => (int) $v->id_kunjungan, 'status' => 'pending']);
        }

        // 4. Auto-close eval timeouts (>7d since the eval_link was ENQUEUED, no eval rows).
        //    Keyed off o.created_at (enqueue time ≈ "menunggu_evaluasi since"), NOT o.sent_at,
        //    so a visit can never get stuck open if the connector permanently fails to deliver
        //    the link (sent_at would stay NULL forever). Idempotent: only menunggu_evaluasi rows match.
        $stale = $this->db->query(
            "SELECT k.id_kunjungan FROM tamdes_kunjungan k
             JOIN wa_outbox o ON o.id_kunjungan = k.id_kunjungan AND o.msg_type = 'eval_link'
             WHERE k.created_by = 'whatsapp' AND k.status = 'menunggu_evaluasi'
               AND o.created_at < ?
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

        // 5. Auto-close WA visits stuck in evaluasi_selesai (eval already filled) > 3 jam → selesai.
        //    Pengaman bila operator lupa klik "Selesai". selesai_timestamp dicap saat evaluasi
        //    disubmit (= waktu evaluasi selesai), jadi itulah acuan jeda 3 jam-nya.
        $stale_done = $this->db->query(
            "SELECT k.id_kunjungan FROM tamdes_kunjungan k
             WHERE k.created_by = 'whatsapp' AND k.status = 'evaluasi_selesai'
               AND k.selesai_timestamp IS NOT NULL AND k.selesai_timestamp < ?",
            [date('Y-m-d H:i:s', time() - 3 * 3600)]
        )->result();
        foreach ($stale_done as $v) {
            $idk = (int) $v->id_kunjungan;
            $this->db->where('id_kunjungan', $idk)->update('tamdes_kunjungan', ['status' => 'selesai']);
            $this->wa_closing_enqueue($idk);
            $this->audit_system('auto_close_wa_done', 'visit', $idk, ['from' => 'evaluasi_selesai', 'to' => 'selesai']);
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

    // Returning guests. $force=false → progressive profiling (only fill columns that are
    // currently empty). $force=true → "Perbarui Profil": overwrite with any non-empty
    // provided value (the requester explicitly chose to edit their profile).
    private function wa_profile_patch($existing, $input, $force = false) {
        $patch = [];
        // Field yang ditampilkan & boleh di-overwrite saat "Perbarui Profil" (force).
        $fields = ['nama','email','jeniskelamin','umur','pendidikan','pekerjaan','kategori_instansi','nama_instansi','pemanfaatan'];
        // Field tambahan (parity dgn kiosk): SELALU fill-empties-only, JANGAN overwrite — prefill
        // sengaja tak mengembalikan field sensitif ini, jadi form Perbarui Profil menampilkan
        // DEFAULT bukan nilai asli; meng-overwrite akan menimpa data asli dengan default.
        $fill_only  = ['disabilitas','jenis_disabilitas','pekerjaan_lainnya','kategori_lainnya','pemanfaatan_lainnya','pengaduan'];
        $int_fields = ['umur','disabilitas','jenis_disabilitas'];
        foreach (array_merge($fields, $fill_only) as $f) {
            $cur       = $existing->$f ?? null;
            $new       = $input[$f] ?? null;
            $isEmpty   = ($cur === null || $cur === '' || $cur === 0 || $cur === '0');
            $overwrite = $force && !in_array($f, $fill_only, true);
            if ($new !== null && $new !== '' && ($overwrite || $isEmpty)) {
                $patch[$f] = in_array($f, $int_fields, true) ? (int) $new : $new;
            }
        }
        return $patch;
    }

    // Inbox display name for a pending phone — DB only, single-match (privacy invariant,
    // mirrors session() GET). Returns tamdes_buku.nama ONLY if exactly one row matches the
    // number; else null (unknown number, or shared/reassigned number → show no identity).
    // The self-reported WhatsApp pushname is deliberately NOT used as a name source.
    private function wa_known_name($phone_norm) {
        $m = $this->db->select('nama')->where('notel', $phone_norm)->limit(2)->get('tamdes_buku')->result();
        return (count($m) === 1 && trim((string) $m[0]->nama) !== '') ? $m[0]->nama : null;
    }

    // Notif ke GRUP WhatsApp petugas. Group id (@g.us) dibaca dari push.php (wa_notify_group);
    // kosong → tidak mengirim apa-apa. Connector mengirim lewat outbox (wa_chat_id = grup).
    private function wa_notify_group_enqueue($body) {
        $gid = trim((string) $this->push_config('wa_notify_group'));
        if ($gid === '') return;
        $this->db->insert('wa_outbox', ['phone_raw' => $gid, 'wa_chat_id' => $gid, 'msg_type' => 'group_notify', 'body' => $body, 'status' => 'pending']);
    }

    // Pesan penutup formal saat sesi WA ditutup (manual operator ATAU auto 3 jam).
    // Ledger-dedup by msg_type='closing' → tak pernah ganda walau dipanggil dua jalur.
    private function wa_closing_enqueue($id_kunjungan) {
        $idk = (int) $id_kunjungan;
        $dup = $this->db->where('id_kunjungan', $idk)->where('msg_type', 'closing')->count_all_results('wa_outbox');
        if ($dup > 0) return;
        $info = $this->db->query(
            "SELECT b.notel,
                    (SELECT s.wa_chat_id FROM wa_sessions s WHERE s.id_kunjungan = k.id_kunjungan ORDER BY s.id DESC LIMIT 1) AS wa_chat_id
             FROM tamdes_kunjungan k JOIN tamdes_buku b ON b.id_user = k.id_user
             WHERE k.id_kunjungan = ?", [$idk]
        )->row();
        if (!$info) return;
        $body = "Terima kasih telah menggunakan layanan data BPS Provinsi Maluku Utara. "
              . "Permintaan Anda telah selesai kami proses. Semoga data yang kami sampaikan bermanfaat. "
              . "Salam hangat, semoga hari Anda menyenangkan 🙂";
        $this->db->insert('wa_outbox', [
            'phone_raw' => $info->notel, 'wa_chat_id' => ($info->wa_chat_id ?: $info->notel),
            'msg_type'  => 'closing', 'body' => $body, 'id_kunjungan' => $idk, 'status' => 'pending',
        ]);
    }

    /* ── live-chat helpers ── */

    private function wa_is_pst_role() {
        $role = $this->current_user->role ?? '';
        return in_array($role, ['petugas_pst', 'operator', 'admin', 'superadmin', 'pimpinan'], true);
    }

    private function wa_media_dir() {
        $dir = FCPATH . 'assets/wa_media/';
        if (!is_dir($dir)) @mkdir($dir, 0775, true);
        return $dir;
    }

    private function wa_mime_allowed($mime) {
        return in_array($mime, [
            'image/jpeg', 'image/png', 'image/webp', 'image/gif',
            'application/pdf', 'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ], true);
    }

    private function wa_ext_for_mime($mime) {
        $map = [
            'image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp', 'image/gif' => 'gif',
            'application/pdf' => 'pdf', 'application/msword' => 'doc',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document' => 'docx',
            'application/vnd.ms-excel' => 'xls',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' => 'xlsx',
        ];
        return $map[$mime] ?? 'bin';
    }

    private function wa_detect_mime($path, $fallback = '') {
        if (function_exists('finfo_open')) {
            $fi = finfo_open(FILEINFO_MIME_TYPE);
            if ($fi) { $m = finfo_file($fi, $path); finfo_close($fi); if ($m) return $m; }
        }
        return $fallback;
    }

    // Sesi aktif (mirror logika ingest 48h) — guard pesan masuk + konteks id_kunjungan.
    private function wa_active_session($phone_norm) {
        return $this->db->query(
            "SELECT s.id, s.wa_chat_id, s.id_kunjungan FROM wa_sessions s
             LEFT JOIN tamdes_kunjungan k ON k.id_kunjungan = s.id_kunjungan
             WHERE s.phone_norm = ?
               AND ( (s.state = 'awaiting_form' AND s.created_at > (NOW() - INTERVAL 48 HOUR))
                     OR (s.state = 'submitted' AND k.status IS NOT NULL AND k.status <> 'selesai') )
             ORDER BY s.id DESC LIMIT 1",
            [$phone_norm]
        )->row();
    }

    // Sesi terbaru untuk nomor (alamat balas + konteks) — petugas boleh kirim kapan pun.
    private function wa_latest_session($phone_norm) {
        return $this->db->select('id, wa_chat_id, id_kunjungan')->where('phone_norm', $phone_norm)
                        ->order_by('id', 'DESC')->limit(1)->get('wa_sessions')->row();
    }

    private function wa_msg_public($m) {
        if (!$m) return null;
        return [
            'id'         => (int) $m->id,
            'direction'  => $m->direction,
            'msg_type'   => $m->msg_type,
            'body'       => $m->body,
            'media_url'  => $m->media_path ? ('/api/wa/media/' . (int) $m->id) : null,
            'media_name' => $m->media_name,
            'media_mime' => $m->media_mime,
            'status'     => $m->status,
            'created_at' => $m->created_at,
        ];
    }
}
