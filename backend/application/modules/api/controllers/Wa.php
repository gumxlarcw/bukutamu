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

        // ── Verifier fast-path: a verifikator replying 1/2/3 is NOT a customer. ──────────────
        // Intercept BEFORE the intake state machine so a verifier never creates/advances a
        // wa_session — their reply drives Deliveries verification, not the intake wizard.
        // Non-verifier senders skip this entirely and fall through unchanged.
        $this->load->model('delivery_model');
        if ($this->_is_verifier_sender($phone_norm)) {
            $this->_handle_verifier_reply($phone_norm, $reply_to, trim((string) ($input['text'] ?? '')));
            $this->json_response(['success' => true, 'data' => ['verifier' => true], 'message' => 'OK']);
        }

        // Active session for this phone? → continuation (bot stays silent; petugas handles
        // the chat manually). Exception: awaiting_category sessions are actively routed
        // by wa_handle_category_choice(). "Active" = visitor picking a category or link
        // sent but form not submitted AND still within the 48h link TTL (awaiting_form),
        // OR submitted with a visit that is not yet 'selesai'. Once the visit is 'selesai',
        // the session is expired, its link is past 48h, or its visit is deleted, the next
        // message is a NEW request → mint a fresh link. The 48h bound is what lets an
        // expired link recover: re-messaging gets a new link, not a stale one.
        $open = $this->db->query(
            "SELECT s.id, s.state, s.phone_raw, s.phone_norm, s.category, s.id_kunjungan
             FROM wa_sessions s
             LEFT JOIN tamdes_kunjungan k ON k.id_kunjungan = s.id_kunjungan
             WHERE s.phone_norm = ?
               AND ( (s.state IN ('awaiting_category','awaiting_form') AND s.created_at > (NOW() - INTERVAL 48 HOUR))
                     OR (s.state = 'submitted' AND k.status IS NOT NULL AND k.status <> 'selesai') )
             ORDER BY s.id DESC LIMIT 1",
            [$phone_norm]
        )->row();
        if ($open) {
            $this->db->where('id', $open->id)->update('wa_sessions', ['last_inbound_at' => date('Y-m-d H:i:s'), 'wa_chat_id' => $reply_to]);
            $text = strtolower(trim((string) ($input['text'] ?? '')));

            // Mitigasi: keyword global → kembali ke menu kapan saja.
            if (in_array($text, ['menu', '0'], true)) {
                $this->db->where('id', $open->id)->update('wa_sessions', ['state' => 'awaiting_category', 'category' => null]);
                $this->wa_enqueue_user($open->phone_raw, $reply_to, 'menu', $this->wa_menu_text());
                $this->json_response(['success' => true, 'data' => ['session_id' => (int) $open->id, 'new' => false], 'message' => 'OK']);
            }
            // Sedang memilih kategori → proses pilihan.
            if ($open->state === 'awaiting_category') {
                $this->wa_handle_category_choice($open, $reply_to, $text);
                $this->json_response(['success' => true, 'data' => ['session_id' => (int) $open->id, 'new' => false], 'message' => 'OK']);
            }
            // Mitigasi: user salah pilih (#2/#3) dan balas "1" → alihkan ke form Permintaan Data.
            if ($text === '1' && in_array($open->category, ['offline', 'lainnya'], true)) {
                $this->wa_switch_to_data($open, $reply_to);
                $this->json_response(['success' => true, 'data' => ['session_id' => (int) $open->id, 'new' => false], 'message' => 'OK']);
            }
            // awaiting_form / submitted lain → diam (petugas tangani live-chat).
            $this->json_response(['success' => true, 'data' => ['session_id' => (int) $open->id, 'new' => false], 'message' => 'OK']);
        }

        // Kontak baru → state awaiting_category, kirim MENU (belum kirim link form).
        // Ping grup "Kontak Baru" DITUNDA sampai kategori dipilih (lihat parser) → kurangi noise.
        $this->db->insert('wa_sessions', [
            'phone_norm'      => $phone_norm,
            'phone_raw'       => $phone_raw,
            'wa_chat_id'      => $reply_to,
            'state'           => 'awaiting_category',
            'last_inbound_at' => date('Y-m-d H:i:s'),
        ]);
        $sid = (int) $this->db->insert_id();
        $this->wa_enqueue_user($phone_raw, $reply_to, 'menu', $this->wa_menu_text());

        $this->json_response(['success' => true, 'data' => ['session_id' => $sid, 'new' => true], 'message' => 'OK']);
    }

    /* ───────────────────────── verifier WA reply fast-path (data deliveries) ───────────────────────── */

    // True when the inbound sender is an active verifikator. notel is stored as the admin
    // typed it (08…/+62…), so normalize BOTH sides with the SAME helper ingest() used on the
    // inbound phone before comparing — never a raw string compare. Caller loads delivery_model.
    private function _is_verifier_sender($phone_norm) {
        if ($phone_norm === '') return false;
        foreach ($this->delivery_model->verifier_notels() as $notel) {
            if ($this->normalize_phone($notel) === $phone_norm) return true;
        }
        return false;
    }

    // Parse a verifier reply and apply the decision through the SHARED Delivery_model::apply_decision
    // (the exact transition the web verify() uses — never reimplemented here). Format:
    //   [<short_code>] <1|2|3> [note]   e.g. "1", "2 kurang lengkap", "V37 3 sudah final".
    // 1→setuju, 2→revisi, 3→setuju_catatan. No short code → FIFO oldest pending. Always replies
    // to the verifier and RETURNS without touching the customer intake state machine.
    private function _handle_verifier_reply($phone_norm, $reply_to, $text) {
        $target         = null;
        $rest           = $text;
        $has_short_code = false;
        $code_typed     = '';
        // Optional leading short code (e.g. "V37") → target that specific pending delivery.
        if (preg_match('/^\s*(V\d+)\b\s*(.*)$/is', $text, $m)) {
            $has_short_code = true;
            $code_typed     = strtoupper($m[1]);
            $target         = $this->delivery_model->by_short_code($code_typed);
            $rest           = $m[2];
        }
        // Required leading decision digit 1|2|3; the remainder is the note.
        if (!preg_match('/^\s*([123])\b\s*(.*)$/s', $rest, $m2)) {
            $this->_verifier_say($phone_norm, $reply_to,
                "Mohon balas dengan 1 (Setuju), 2 (Revisi), atau 3 (Setuju dengan catatan). Untuk meninjau berkas, buka panel verifikasi web.");
            return;
        }
        $decision = ['1' => 'setuju', '2' => 'revisi', '3' => 'setuju_catatan'][$m2[1]];
        $note     = trim($m2[2]);

        // Short code was explicitly typed but didn't match any pending delivery → bail immediately.
        // A typo must NOT release someone else's data via FIFO fallback.
        if ($has_short_code && !$target) {
            $this->_verifier_say($phone_norm, $reply_to,
                "⚠️ Kode {$code_typed} tidak ditemukan atau sudah diproses. Mohon periksa kembali.");
            return;
        }
        // No short code given → FIFO map to the oldest pending verification.
        if (!$target) $target = $this->delivery_model->oldest_pending_for_verifier();
        if (!$target) {
            $this->_verifier_say($phone_norm, $reply_to, "Tidak ada permohonan verifikasi yang menunggu.");
            return;
        }

        // revisi / setuju_catatan MUST carry a note — never apply the decision without one.
        if (($decision === 'revisi' || $decision === 'setuju_catatan') && $note === '') {
            $this->_verifier_say($phone_norm, $reply_to,
                "Untuk pilihan ini, mohon sertakan catatan. Contoh: \"2 tahun 2023 belum lengkap\".");
            return;
        }

        $v   = $this->delivery_model->active_verifier();
        $res = $this->delivery_model->apply_decision(
            (int) $target->id, $decision, ($decision === 'setuju' ? null : $note), (int) $v->id
        );

        // Audit lives in the caller (the model is pure DB ops). Mirror the web verify(): only
        // log applied decisions (ok=true covers 'terkirim' and the approved-but-unsent case).
        if ($res['ok']) {
            $this->audit('delivery_verify_wa_' . $decision, 'delivery', (int) $target->id, ['status' => $res['status'], 'verifier_id' => (int) $v->id]);
        }

        $sc = $res['short_code'];
        if ($res['ok'] && $res['status'] === 'terkirim') {
            $reply = "✅ {$sc} disetujui dan dikirim ke pemohon.";
        } elseif ($res['ok'] && $res['reason'] === 'send_failed') {
            $reply = "✅ {$sc} disetujui, namun belum terkirim (alamat WhatsApp pemohon tidak ditemukan).";
        } elseif ($res['ok'] && $res['status'] === 'revisi') {
            $reply = "✏️ {$sc} dikembalikan ke operator untuk revisi.";
        } elseif (!$res['ok'] && $res['reason'] === 'conflict') {
            $reply = "⚠️ {$sc} sudah diproses sebelumnya.";
        } else {
            $reply = $res['message'];
        }
        $this->_verifier_say($phone_norm, $reply_to, $reply);
    }

    // Enqueue a bot reply to the verifier — the connector sends it next poll. Mirrors
    // wa_enqueue_user but tagged msg_type='verif_request' (its own outbox category).
    private function _verifier_say($phone_raw, $reply_to, $body) {
        $this->db->insert('wa_outbox', [
            'phone_raw'  => $phone_raw,
            'wa_chat_id' => $reply_to,
            'msg_type'   => 'verif_request',
            'body'       => $body,
            'status'     => 'pending',
        ]);
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
                'quoted_msg_id' => $m->quoted_msg_id,
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

        // Antrian "sudah dibaca" + reaksi keluar (read-once). DILEWATI saat ada command (logout):
        // connector return lebih awal sebelum loop seen/react → baris yang sudah dihapus tak diproses
        // (hilang). Tunda ke tick berikutnya. NB sisa risiko: bila connector crash antara baca & dispatch,
        // reaksi bisa hilang (at-most-once, best-effort UX); seen sembuh sendiri saat chat dibuka ulang.
        $seen = []; $reactions_out = [];
        if (!$command) {
            $seenRows = $this->db->order_by('id', 'ASC')->limit(20)->get('wa_seen_queue')->result();
            $seen = array_map(function ($s) { return $s->wa_chat_id; }, $seenRows);
            if ($seenRows) {
                $this->db->where_in('id', array_map(function ($s) { return (int) $s->id; }, $seenRows))->delete('wa_seen_queue');
            }
            $reactRows = $this->db->order_by('id', 'ASC')->limit(20)->get('wa_react_queue')->result();
            $reactions_out = array_map(function ($r) { return ['wa_msg_id' => $r->wa_msg_id, 'emoji' => $r->emoji]; }, $reactRows);
            if ($reactRows) $this->db->where_in('id', array_map(function ($r) { return (int) $r->id; }, $reactRows))->delete('wa_react_queue');
        }

        $this->json_response(['success' => true, 'data' => ['messages' => $messages, 'command' => $command, 'backfills' => $backfills, 'seen' => $seen, 'reactions_out' => $reactions_out], 'message' => 'OK']);
    }

    // POST /api/wa/disconnect (auth + PST role) — admin minta connector putus tautan & tampilkan QR baru (ganti nomor).
    public function disconnect() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_auth();
        $this->require_role_in(['admin', 'superadmin']); // #11 — device unlink is admin-only
        $this->db->where('id', 1)->update('wa_qr_state', ['command' => 'logout', 'ready' => 0, 'qr' => null, 'number' => null]);
        $this->json_response(['success' => true, 'data' => null, 'message' => 'Memutuskan koneksi… QR baru akan muncul sebentar lagi.']);
    }

    // POST /api/wa/sessions/(:num)/send-data-form (auth + PST) — petugas alihkan pemohon yang
    // sebenarnya butuh data online (mis. salah pilih #2 Antrian Offline / #3 Lainnya) ke form
    // Permintaan Data. Reuse wa_switch_to_data: menolak bila kunjungan sudah check-in kiosk/selesai,
    // selain itu set category='data' + kirim tautan form (id_kunjungan dipertahankan utk konversi).
    public function send_data_form($sid) {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_auth();
        if (!$this->wa_can_write()) $this->json_response(['success' => false, 'message' => 'Akses ditolak.'], 403); // #5 pimpinan read-only
        $sid  = (int) $sid;
        $sess = $this->db->get_where('wa_sessions', ['id' => $sid])->row();
        if (!$sess) $this->json_response(['success' => false, 'message' => 'Sesi tidak ditemukan'], 404);
        // Hanya alihkan sesi Antrian Offline / Lainnya — JANGAN reset sesi data yang sedang diproses.
        if (!in_array($sess->category, ['offline', 'lainnya'], true)) {
            $this->json_response(['success' => false, 'message' => 'Hanya untuk sesi Antrian Offline / Lainnya.'], 409);
        }
        $this->wa_switch_to_data($sess, ($sess->wa_chat_id ?: $sess->phone_raw));
        $this->json_response(['success' => true, 'data' => null, 'message' => 'Diproses — tautan form Permintaan Data dikirim ke pemohon (kecuali bila kunjungan sudah dilayani langsung).']);
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
        $ofail = (isset($input['outbox_fail']) && is_array($input['outbox_fail'])) ? array_map('intval', $input['outbox_fail']) : [];
        $acks  = (isset($input['ack_states']) && is_array($input['ack_states'])) ? $input['ack_states'] : [];
        $reacts = (isset($input['reactions']) && is_array($input['reactions'])) ? $input['reactions'] : [];
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
        // Outbox GAGAL kirim (connector menyerah setelah MAX_SEND_ATTEMPTS) → naikkan attempts &
        // tandai 'failed' setelah N kali. Tanpa ini baris tetap 'pending' selamanya → terkirim BASI
        // saat connector restart (failCount in-memory connector ter-reset). Lihat memo wa_outbox_stale_delivery.
        if ($ofail) {
            $max = (int) ($this->push_config('wa_outbox_max_attempts') ?: 5);
            $this->db->where_in('id', $ofail)->set('attempts', 'attempts+1', false)->update('wa_outbox');
            $this->db->where_in('id', $ofail)->where('status', 'pending')->where('attempts >=', $max)
                     ->update('wa_outbox', ['status' => 'failed']);
        }
        // Status pengiriman WhatsApp (delivered/read) → naikkan `ack` pesan keluar (jangan turunkan).
        foreach ($acks as $a) {
            $wid = trim((string) ($a['wa_msg_id'] ?? ''));
            $lvl = (int) ($a['ack'] ?? 0);
            if ($wid === '' || $lvl <= 0) continue;
            $this->db->where('wa_msg_id', $wid)->where('direction', 'out')->where('ack <', $lvl)
                     ->update('wa_messages', ['ack' => $lvl]);
        }
        // Reaksi masuk (visitor → kita) dari message_reaction connector → simpan di baris pesan terkait.
        foreach ($reacts as $r) {
            $wid = trim((string) ($r['wa_msg_id'] ?? ''));
            if ($wid === '') continue;
            $emoji = (string) ($r['emoji'] ?? '');
            $this->db->where('wa_msg_id', $wid)->update('wa_messages', ['reaction' => ($emoji !== '' ? mb_substr($emoji, 0, 32) : null)]);
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

        $type = in_array(($in['type'] ?? 'text'), ['text', 'image', 'document', 'audio', 'video', 'sticker', 'location', 'contact'], true) ? $in['type'] : 'text';
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
        // Hanya tipe ber-file yang lewat pipeline media; location/contact (& text) simpan body saja.
        if (in_array($type, ['image', 'document', 'audio', 'video', 'sticker'], true)) {
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
            $derived = $this->wa_media_type($mime);
            // webp dari WA = stiker bila connector memberi hint type='sticker'; selain itu ikuti mime.
            $type = ($derived === 'image' && ($in['type'] ?? '') === 'sticker') ? 'sticker' : $derived;
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
            'quoted_msg_id'  => (isset($in['quoted_msg_id']) && trim((string) $in['quoted_msg_id']) !== '') ? trim((string) $in['quoted_msg_id']) : null,
            'quoted_preview' => isset($in['quoted_preview']) ? mb_substr((string) $in['quoted_preview'], 0, 255) : null,
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
            // Ambil 500 pesan TERBARU lalu balik ke urutan kronologis. Dgn ASC+LIMIT, thread yang
            // melewati 500 pesan akan membeku di 500 pesan TERLAMA & pesan baru tak pernah muncul
            // (audit 2026-06-19 — message-loss vector #1). DESC+limit lalu reverse = selalu tampil ekor terbaru.
            $rows = $this->db->where('phone_norm', $phone)->where('id >', $after)
                             ->order_by('id', 'DESC')->limit(500)->get('wa_messages')->result();
            $rows = array_reverse($rows);
            $this->json_response(['success' => true, 'data' => array_map([$this, 'wa_msg_public'], $rows), 'message' => 'OK']);
        }

        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            if (!$this->wa_can_write()) $this->json_response(['success' => false, 'message' => 'Akses ditolak.'], 403); // #5 pimpinan read-only
            $this->require_rate_limit('wa/chat', 15);
            $in    = $this->get_json_input();
            $phone = $this->normalize_phone((string) ($in['phone'] ?? ''));
            $body  = trim((string) ($in['body'] ?? ''));
            if ($phone === '' || $body === '') $this->json_response(['success' => false, 'message' => 'phone & body diperlukan'], 422);
            if (mb_strlen($body) > 4096) $this->json_response(['success' => false, 'message' => 'Pesan maksimal 4096 karakter'], 422);
            $sess = $this->wa_latest_session($phone);
            if (!$sess || !$sess->wa_chat_id) $this->json_response(['success' => false, 'message' => 'Kontak tidak ditemukan'], 404);
            $this->wa_require_session_owner($sess); // #17 — only the assigned operator (or admin) may reply
            // Reply: FE mengirim DB id pesan yang dibalas → resolve wa_msg_id (utk kutip di WA) + snapshot teks.
            $quoted_db = (int) ($in['quoted_id'] ?? 0);
            $quoted_wa = null; $quoted_preview = null;
            if ($quoted_db > 0) {
                $qr = $this->db->select('wa_msg_id, body, msg_type')->where('id', $quoted_db)->where('phone_norm', $phone)->limit(1)->get('wa_messages')->row();
                if ($qr) {
                    $quoted_wa = $qr->wa_msg_id;
                    $quoted_preview = mb_substr(($qr->body !== null && $qr->body !== '') ? $qr->body : ('[' . $qr->msg_type . ']'), 0, 255);
                }
            }
            $ok = $this->db->insert('wa_messages', [
                'phone_norm'   => $phone,
                'wa_chat_id'   => $sess->wa_chat_id,
                'id_kunjungan' => $sess->id_kunjungan ?: null,
                'direction'    => 'out',
                'msg_type'     => 'text',
                'body'         => $body,
                'quoted_msg_id'  => $quoted_wa,
                'quoted_preview' => $quoted_preview,
                'status'       => 'pending',
            ]);
            // db_debug off di production → insert bisa gagal diam-diam. Tanpa cek ini FE dapat 200+data:null,
            // composer dikosongkan, pesan hilang tanpa jejak (audit 2026-06-19; mirror messages_upload & chat_ingest).
            if ($ok === false) $this->json_response(['success' => false, 'message' => 'Gagal menyimpan pesan'], 500);
            $id = (int) $this->db->insert_id();
            $this->audit_system('wa_chat_send', 'message', $id, ['type' => 'text']);
            $this->json_response(['success' => true, 'data' => $this->wa_msg_public($this->db->get_where('wa_messages', ['id' => $id])->row()), 'message' => 'OK']);
        }

        $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
    }

    // POST /api/wa/seen { phone } — petugas membuka/melihat chat → antri sendSeen (centang biru utk visitor).
    public function seen() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_auth();
        if (!$this->wa_can_write()) $this->json_response(['success' => false, 'message' => 'Akses ditolak.'], 403); // #5 pimpinan read-only
        $in    = $this->get_json_input();
        $phone = $this->normalize_phone((string) ($in['phone'] ?? ''));
        if ($phone === '') $this->json_response(['success' => false, 'message' => 'phone diperlukan'], 422);
        $sess = $this->wa_latest_session($phone);
        if ($sess && $sess->wa_chat_id) {
            // INSERT IGNORE (UNIQUE wa_chat_id) → tak menumpuk saat chat dibuka berulang.
            $this->db->query('INSERT IGNORE INTO wa_seen_queue (wa_chat_id) VALUES (?)', [$sess->wa_chat_id]);
        }
        // Tandai inbox sudah dibaca: majukan last_read_msg_id ke pesan terakhir nomor ini (forward-only).
        $maxRow = $this->db->select_max('id')->where('phone_norm', $phone)->get('wa_messages')->row();
        $maxId  = ($maxRow && $maxRow->id) ? (int) $maxRow->id : 0;
        $this->db->query(
            "INSERT INTO wa_read_state (phone_norm, last_read_msg_id) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE last_read_msg_id = GREATEST(last_read_msg_id, ?)",
            [$phone, $maxId, $maxId]
        );
        $this->json_response(['success' => true, 'data' => null, 'message' => 'OK']);
    }

    // POST /api/wa/react { wa_msg_id, emoji } — petugas memberi reaksi emoji ke sebuah pesan ('' = hapus).
    public function react() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_auth();
        if (!$this->wa_can_write()) $this->json_response(['success' => false, 'message' => 'Akses ditolak.'], 403); // #5 pimpinan read-only
        $in    = $this->get_json_input();
        $id    = (int) ($in['id'] ?? 0);
        $emoji = mb_substr((string) ($in['emoji'] ?? ''), 0, 32);
        if ($id <= 0) $this->json_response(['success' => false, 'message' => 'id pesan diperlukan'], 422);
        $row = $this->db->select('wa_msg_id, phone_norm')->where('id', $id)->limit(1)->get('wa_messages')->row();
        if (!$row || !$row->wa_msg_id) $this->json_response(['success' => false, 'message' => 'Pesan belum terkirim — tak bisa direaksi'], 409);
        $this->wa_require_session_owner($this->wa_latest_session($row->phone_norm)); // #17 — reactions only by the assigned operator
        $this->db->insert('wa_react_queue', ['wa_msg_id' => $row->wa_msg_id, 'emoji' => $emoji]); // connector message.react()
        $this->db->where('id', $id)->update('wa_messages', ['reaction' => ($emoji !== '' ? $emoji : null)]); // optimistic
        $this->json_response(['success' => true, 'data' => null, 'message' => 'OK']);
    }

    // POST /api/wa/messages/upload (multipart: phone, file, caption?) — kirim media keluar.
    public function messages_upload() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_auth();
        if (!$this->wa_can_write()) $this->json_response(['success' => false, 'message' => 'Akses ditolak.'], 403); // #5 pimpinan read-only
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
        $this->wa_require_session_owner($sess); // #17 — only the assigned operator (or admin) may send media

        $name = bin2hex(random_bytes(16)) . '.' . $this->wa_ext_for_mime($mime);
        $dest = $this->wa_media_dir() . $name;
        if (!move_uploaded_file($f['tmp_name'], $dest)) $this->json_response(['success' => false, 'message' => 'Gagal menyimpan file'], 500);
        @chmod($dest, 0644);
        $type = $this->wa_media_type($mime);

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
        $disp  = (strpos($mime, 'image/') === 0 || strpos($mime, 'audio/') === 0 || strpos($mime, 'video/') === 0) ? 'inline' : 'attachment';
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
        $this->require_role_in(['admin', 'superadmin']); // #6 — admin/superadmin only (pimpinan shares level 2)
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
        if (!$this->wa_can_write()) $this->json_response(['success' => false, 'message' => 'Akses ditolak.'], 403); // #5 pimpinan read-only
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
        if (!$this->wa_can_write()) $this->json_response(['success' => false, 'message' => 'Akses ditolak.'], 403); // #5 pimpinan read-only
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

    // POST /api/wa/sessions/(:num)/assign — operator "Ambil alih" sebuah sesi (pending atau visit).
    // Klaim ATOMIK (anti-TOCTOU): hanya yang pertama menang. Terkunci ke operator pertama;
    // hanya admin/superadmin yang boleh memindahkan (override). (auth + PST role)
    public function session_assign($id) {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_auth();
        if (!$this->wa_can_write()) $this->json_response(['success' => false, 'message' => 'Akses ditolak.'], 403); // #5 pimpinan read-only
        $sid  = (int) $id;
        $uid  = (int) ($this->current_user->id ?? 0);
        $role = $this->current_user->role ?? '';
        if ($uid <= 0) $this->json_response(['success' => false, 'message' => 'Akun ini tidak dapat mengambil alih sesi (gunakan akun operator).'], 403);
        $sess = $this->db->get_where('wa_sessions', ['id' => $sid])->row();
        if (!$sess) $this->json_response(['success' => false, 'message' => 'Sesi tidak ditemukan'], 404);

        $now = date('Y-m-d H:i:s');
        // Klaim atomik untuk sesi yang belum dipegang siapa pun.
        $this->db->where('id', $sid)->where('assigned_to', null)
                 ->update('wa_sessions', ['assigned_to' => $uid, 'assigned_at' => $now]);
        $claimed = ($this->db->affected_rows() === 1);

        if (!$claimed) {
            $cur    = $this->db->select('assigned_to')->get_where('wa_sessions', ['id' => $sid])->row();
            $holder = (int) ($cur->assigned_to ?? 0);
            if ($holder === $uid) {
                $this->json_response(['success' => true, 'data' => ['assigned_to' => $uid, 'operator_nama' => $this->wa_operator_name($uid)], 'message' => 'Sudah Anda tangani']);
            }
            if (!in_array($role, ['admin', 'superadmin'], true)) {
                $this->json_response(['success' => false, 'message' => 'Sudah ditangani oleh ' . $this->wa_operator_name($holder)], 409);
            }
            // Admin override → pindahkan ke admin yang meminta.
            $this->db->where('id', $sid)->update('wa_sessions', ['assigned_to' => $uid, 'assigned_at' => $now]);
        }

        // Pesan "sedang ditangani" — HANYA dari aksi interaktif ini, tak pernah dari backfill.
        if ($sess->wa_chat_id) {
            $nama = $this->wa_operator_name($uid);
            $body = "Permintaan Anda sedang ditangani oleh *{$nama}*. Mohon menunggu, kami akan segera memproses permintaan Anda.";
            $this->db->insert('wa_outbox', [
                'phone_raw' => $sess->phone_raw, 'wa_chat_id' => $sess->wa_chat_id,
                'msg_type'  => 'ditangani', 'body' => $body,
                'id_kunjungan' => ($sess->id_kunjungan ?: null), 'status' => 'pending',
            ]);
        }
        $this->audit('wa_assign', 'wa_session', $sid, ['assigned_to' => $uid]);
        $this->json_response(['success' => true, 'data' => ['assigned_to' => $uid, 'operator_nama' => $this->wa_operator_name($uid)], 'message' => 'Anda mengambil alih sesi ini']);
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
            ->select("(SELECT s.id FROM wa_sessions s WHERE s.id_kunjungan = k.id_kunjungan ORDER BY s.id DESC LIMIT 1) AS session_id", FALSE)
            ->select("(SELECT s.assigned_to FROM wa_sessions s WHERE s.id_kunjungan = k.id_kunjungan ORDER BY s.id DESC LIMIT 1) AS assigned_to", FALSE)
            ->select("(SELECT au.nama FROM wa_sessions s JOIN admin_users au ON au.id = s.assigned_to WHERE s.id_kunjungan = k.id_kunjungan ORDER BY s.id DESC LIMIT 1) AS operator_nama", FALSE)
            ->select("(SELECT s.category FROM wa_sessions s WHERE s.id_kunjungan = k.id_kunjungan ORDER BY s.id DESC LIMIT 1) AS category", FALSE)
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
                'session_id'    => ($v->session_id !== null ? (int) $v->session_id : null),
                'status'        => $v->status,
                'date'          => $v->dt,
                'nama'          => $v->nama,
                'nama_instansi' => $v->nama_instansi,
                'notel'         => $v->notel,
                'permintaan'    => $v->permintaan,
                'assigned_to'   => ($v->assigned_to !== null ? (int) $v->assigned_to : null),
                'operator_nama' => ($v->operator_nama ? $this->wa_strip_role_annot($v->operator_nama) : null),
                'category'      => ($v->category ?: null),
            ];
        }

        // 2) Sesi yang sudah dikirimi link tapi BELUM mengisi form (awaiting_form).
        $pend = $this->db->select('s.id, s.phone_norm, s.last_inbound_at, s.link_sent_at, s.created_at, s.category, s.assigned_to, au.nama AS operator_nama')
                         ->from('wa_sessions s')
                         ->join('admin_users au', 'au.id = s.assigned_to', 'left')
                         ->where('s.state', 'awaiting_form')
                         ->order_by('s.id', 'DESC')->limit(100)->get()->result();
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
                'assigned_to'   => ($s->assigned_to !== null ? (int) $s->assigned_to : null),
                'operator_nama' => ($s->operator_nama ? $this->wa_strip_role_annot($s->operator_nama) : null),
                'category'      => ($s->category ?: null),
            ];
        }

        // Pesan masuk BELUM dibaca per nomor (badge tombol chat). Satu query grup → map ke item.
        // Pesan masuk LIVE sudah tersimpan terus-menerus (chat_ingest), jadi badge akurat di latar
        // tanpa membuka chat. last_read_msg_id dimajukan saat petugas membuka chat (lihat seen()).
        $unreadRows = $this->db->query(
            "SELECT m.phone_norm, COUNT(*) AS unread
             FROM wa_messages m
             LEFT JOIN wa_read_state rs ON rs.phone_norm = m.phone_norm
             WHERE m.direction = 'in' AND m.id > COALESCE(rs.last_read_msg_id, 0)
             GROUP BY m.phone_norm"
        )->result();
        $unreadMap = [];
        foreach ($unreadRows as $u) $unreadMap[$u->phone_norm] = (int) $u->unread;
        foreach ($items as &$it) { $it['unread'] = ($it['notel'] !== null) ? ($unreadMap[$it['notel']] ?? 0) : 0; }
        unset($it);

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
            // Visit details (if already submitted) so a reopened success ticket shows the
            // queue number + service — like the kiosk ticket — not just WA-{id}.
            $v_no = null; $v_jl = null;
            if ($sess->id_kunjungan) {
                $vrow = $this->db->select('nomor_antrian, jenis_layanan')->get_where('tamdes_kunjungan', ['id_kunjungan' => (int) $sess->id_kunjungan])->row();
                if ($vrow) { $v_no = $vrow->nomor_antrian; $v_jl = json_decode($vrow->jenis_layanan, true); }
            }
            $this->json_response(['success' => true, 'data' => [
                'session_id'    => $id,
                'phone'         => $sess->phone_norm,
                'state'         => $sess->state,
                'category'      => $sess->category ?: 'data',
                'guest'         => $guest,
                'multi_match'   => $multi,
                'id_kunjungan'  => $sess->id_kunjungan ? (int) $sess->id_kunjungan : null,
                'nomor_antrian' => $v_no,
                'jenis_layanan' => is_array($v_jl) ? $v_jl : null,
            ], 'message' => 'OK']);
        }

        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $this->require_rate_limit('wa/intake', 30);

            // Idempotent: already submitted → return existing ticket.
            if ($sess->state === 'submitted' && $sess->id_kunjungan) {
                $this->json_response(['success' => true, 'data' => ['id_kunjungan' => (int) $sess->id_kunjungan, 'ticket' => 'WA-' . $sess->id_kunjungan, 'nomor_antrian' => $this->wa_visit_nomor($sess->id_kunjungan)], 'message' => 'Sudah dikirim']);
            }

            $input    = $this->get_json_input();
            $category = ($sess && !empty($sess->category)) ? $sess->category : 'data';

            // Validasi wajib server-side — FE meng-disable tombol, tapi API bisa dipanggil
            // langsung. Tamu baru tanpa nama = data sampah; tolak di boundary.
            if (trim((string) ($input['nama'] ?? '')) === '') {
                $this->json_response(['success' => false, 'message' => 'Nama wajib diisi'], 422);
            }

            if ($category === 'offline') {
                $jl_in = (isset($input['jenis_layanan']) && is_array($input['jenis_layanan'])) ? array_values($input['jenis_layanan']) : [];
                if (!$jl_in) $this->json_response(['success' => false, 'message' => 'Silakan pilih layanan.'], 422);
                $jenis_layanan = $jl_in;
                $sarana        = (isset($input['sarana']) && is_array($input['sarana'])) ? array_map('intval', $input['sarana']) : [];
                $this->validate_no_cross_layanan($jenis_layanan);          // reject cross-group / unknown
                $this->validate_sarana_for_layanan($jenis_layanan, $sarana);
            } else { // 'data' — online: pilih layanan (4 inti) + sarana KHUSUS ONLINE (tanpa "datang langsung").
                $jl_in = (isset($input['jenis_layanan']) && is_array($input['jenis_layanan'])) ? array_values($input['jenis_layanan']) : [];
                $jenis_layanan = $jl_in ?: ['Konsultasi Statistik'];   // default utk pemanggil lama/tanpa pilihan
                // Sarana online saja: buang kode 1 ("PST datang langsung"); default Aplikasi Chat (16) krn via WA.
                $sarana = (isset($input['sarana']) && is_array($input['sarana']))
                    ? array_values(array_filter(array_map('intval', $input['sarana']), function ($c) { return $c !== 1; }))
                    : [];
                if (!$sarana) $sarana = [16];
                $this->validate_no_cross_layanan($jenis_layanan);
                $this->validate_sarana_for_layanan($jenis_layanan, $sarana);
            }

            // Validasi tahun (boundary, sebelum LOCK → tidak ada kunjungan orphan bila ditolak):
            // format tahun wajar + tahun_akhir tidak boleh sebelum tahun_awal (cegah salah ketik
            // mis. 2015–2014 yang seharusnya 2015–2024).
            $year_min = 1945; $year_max = (int) date('Y') + 1;
            $rows_in  = (isset($input['permintaan']) && is_array($input['permintaan'])) ? $input['permintaan'] : [];
            foreach ($rows_in as $r) {
                $ta = (isset($r['tahun_awal'])  && $r['tahun_awal']  !== '' && $r['tahun_awal']  !== null) ? (int) $r['tahun_awal']  : null;
                $tb = (isset($r['tahun_akhir']) && $r['tahun_akhir'] !== '' && $r['tahun_akhir'] !== null) ? (int) $r['tahun_akhir'] : null;
                if ($ta !== null && ($ta < $year_min || $ta > $year_max)) $this->json_response(['success' => false, 'message' => 'Tahun awal tidak valid (gunakan format tahun, mis. 2024).'], 422);
                if ($tb !== null && ($tb < $year_min || $tb > $year_max)) $this->json_response(['success' => false, 'message' => 'Tahun akhir tidak valid (gunakan format tahun, mis. 2024).'], 422);
                if ($ta !== null && $tb !== null && $tb < $ta)            $this->json_response(['success' => false, 'message' => 'Tahun akhir tidak boleh sebelum tahun awal.'], 422);
            }

            // Guest upsert by phone (LOCK pattern from Kiosk::register). wa_sessions ikut
            // dikunci & dicek-ulang DI DALAM lock: double-submit (TOCTOU) tidak boleh membuat
            // kunjungan ganda — hanya request pertama lolos, sisanya kembalikan tiket lama.
            $this->db->query('LOCK TABLES tamdes_buku WRITE, tamdes_kunjungan WRITE, tamdes_responden_tahunan WRITE, wa_sessions WRITE');
            $fresh = $this->db->get_where('wa_sessions', ['id' => $id])->row();
            if ($fresh && $fresh->state === 'submitted' && $fresh->id_kunjungan && $fresh->category === $category) {
                $this->db->query('UNLOCK TABLES');
                $this->json_response(['success' => true, 'data' => ['id_kunjungan' => (int) $fresh->id_kunjungan, 'ticket' => 'WA-' . $fresh->id_kunjungan, 'nomor_antrian' => $this->wa_visit_nomor($fresh->id_kunjungan)], 'message' => 'Sudah dikirim']);
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

            if (!empty($sess->id_kunjungan)) {
                // Konversi visit lama (#2/#3) → kategori baru: re-label + lanjut isi rows di bawah (tidak duplikat).
                $id_kunjungan = (int) $sess->id_kunjungan;
                // Re-check DI DALAM lock (TOCTOU): kalau visit keburu di-check-in kiosk (created_by='wa_kiosk')
                // atau sudah selesai antara "balas 1" dan submit, JANGAN timpa antrian fisiknya — kembalikan
                // tiket apa adanya (pemohon sudah dilayani langsung).
                $cur = $this->db->select('created_by, status')->get_where('tamdes_kunjungan', ['id_kunjungan' => $id_kunjungan])->row();
                if (!$cur || $cur->created_by !== 'whatsapp' || in_array($cur->status, ['selesai', 'evaluasi_selesai'], true)) {
                    $this->db->query('UNLOCK TABLES');
                    $this->json_response(['success' => true, 'data' => ['id_kunjungan' => $id_kunjungan, 'ticket' => 'WA-' . $id_kunjungan, 'nomor_antrian' => $this->wa_visit_nomor($id_kunjungan)], 'message' => 'Sudah diproses']);
                }
                // Konversi bisa MENGUBAH kategori (mis. #3 lainnya → menu → #2 offline). Set ulang nomor
                // antrian sesuai kategori TUJUAN — offline butuh nomor, data/lainnya null. Tanpa ini, visit
                // hasil konversi-ke-offline tetap NULL → tiket jatuh ke WA-{id}.
                // PENTING: hitung nomor DULU, di LUAR rantai where()->update(). generate_queue_number()
                // memanggil count_all_results() yang me-RESET query builder; kalau dipanggil di dalam array
                // update, where('id_kunjungan') ikut terhapus → UPDATE SEMUA baris (insiden 2026-06-30).
                $conv_no = ($category === 'offline') ? $this->generate_queue_number($jenis_layanan[0] ?? '') : null;
                $this->db->where('id_kunjungan', $id_kunjungan)->update('tamdes_kunjungan', [
                    'jenis_layanan' => json_encode($jenis_layanan), 'sarana' => json_encode($sarana),
                    'status' => 'antri', 'created_by' => 'whatsapp', 'date_visit' => date('Y-m-d H:i:s'),
                    'nomor_antrian' => $conv_no,
                ]);
            } else {
                $this->db->insert('tamdes_kunjungan', [
                    'id_user'          => $id_user,
                    'jenis_layanan'    => json_encode($jenis_layanan),
                    'sarana'           => json_encode($sarana),
                    'layanan_lainnya'  => $input['layanan_lainnya'] ?? null,
                    'sarana_lainnya'   => $input['sarana_lainnya'] ?? null,
                    'date_visit'       => date('Y-m-d H:i:s'),
                    'status'           => 'antri',
                    'nomor_antrian'    => ($category === 'offline') ? $this->generate_queue_number($jenis_layanan[0] ?? '') : null,
                    'created_by'       => 'whatsapp',
                ]);
                $id_kunjungan = (int) $this->db->insert_id();
                if (!$id_kunjungan) { $this->db->query('UNLOCK TABLES'); $this->json_response(['success' => false, 'message' => 'Gagal membuat kunjungan'], 500); }
            }

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

            $g_nama = trim((string) ($input['nama'] ?? '')) ?: ($this->wa_known_name($sess->phone_norm) ?: 'Pemohon');
            if ($category === 'offline') {
                $no  = $this->db->select('nomor_antrian')->get_where('tamdes_kunjungan', ['id_kunjungan' => $id_kunjungan])->row()->nomor_antrian;
                $svc = $jenis_layanan[0] ?? '';
                $body = "✅ *PENDAFTARAN ANTRIAN BERHASIL*\n"
                      . "Badan Pusat Statistik Provinsi Maluku Utara\n\n"
                      . "Berikut detail pendaftaran Anda:\n"
                      . ($no ? "• *Nomor Antrian:* {$no}\n" : '')
                      . "• *Nama:* {$g_nama}\n"
                      . "• *Layanan:* {$svc}\n"
                      . "• *Tanggal:* " . date('d-m-Y') . "\n"
                      . "• *Berlaku:* hari ini\n\n"
                      . "Mohon hadir di Kantor BPS Provinsi Maluku Utara, lalu langsung menuju bagian *Resepsionis* untuk mencetak tiket antrian Anda.\n\n"
                      . "🕒 *Jam Layanan*\n" . $this->jam_layanan_text() . "\n\n"
                      . "Terima kasih atas kunjungan Anda. 🙏";
                $this->wa_enqueue_user($sess->phone_raw, $sess->wa_chat_id, 'confirmation', $body);
                $this->wa_notify_group_enqueue("🗓️ *Daftar Antrian Offline*\nNama: {$g_nama}" . ($no ? "\nNomor antrian: {$no}" : '') . "\nNomor: {$sess->phone_norm}\nTiket: WA-{$id_kunjungan}\n" . $this->wa_public_base() . "/admin/layanan-online");
            } else {
                // data: formal receipt + "✅ Permintaan Data Online Masuk" ping.
                $svc  = $jenis_layanan[0] ?? '';
                $body = "✅ *PERMINTAAN LAYANAN ONLINE DITERIMA*\n"
                      . "Badan Pusat Statistik Provinsi Maluku Utara\n\n"
                      . "Berikut detail permintaan Anda:\n"
                      . "• *Nomor Tiket:* WA-{$id_kunjungan}\n"
                      . "• *Nama:* {$g_nama}\n"
                      . ($svc !== '' ? "• *Layanan:* {$svc}\n" : '')
                      . "• *Tanggal:* " . date('d-m-Y') . "\n";
                if ($recap !== '') $body .= "\nRincian permintaan Anda:{$recap}\n";
                $body .= "\nPermintaan Anda akan kami proses pada jam operasional layanan dan kami balas langsung di chat ini.\n\n"
                       . "🕒 *Jam Layanan*\n" . $this->jam_layanan_text() . "\n\n"
                       . "Terima kasih. 🙏";
                $this->db->insert('wa_outbox', ['phone_raw' => $sess->phone_raw, 'wa_chat_id' => $sess->wa_chat_id, 'msg_type' => 'confirmation', 'body' => $body, 'id_kunjungan' => $id_kunjungan, 'status' => 'pending']);
                $g_inst = trim((string) ($input['nama_instansi'] ?? ''));
                $g_body = "✅ *Permintaan Data Online Masuk*\nTiket: WA-{$id_kunjungan}\nNama: {$g_nama}" . ($g_inst !== '' ? " ({$g_inst})" : '') . "\nNomor: {$sess->phone_norm}\n";
                if ($recap !== '') $g_body .= "Permintaan:{$recap}\n";
                $g_body .= "Mohon diproses: " . $this->wa_public_base() . "/admin/layanan-online";
                $this->wa_notify_group_enqueue($g_body);
            }

            $this->json_response(['success' => true, 'data' => ['id_kunjungan' => $id_kunjungan, 'ticket' => 'WA-' . $id_kunjungan, 'nomor_antrian' => $this->wa_visit_nomor($id_kunjungan)], 'message' => 'Permintaan terkirim']);
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

        // Eval menempel per-kunjungan, tapi tautan WA terikat ke SATU id_kunjungan. Pemohon yang minta
        // data lagi dalam <7 hari kerap memegang tautan SESI LAMA — kalau visit-nya sudah selesai, tautan
        // itu mentok 409 padahal sesi barunya punya evaluasi sendiri yang menunggu. Maka bila visit pada
        // tautan ini bukan menunggu_evaluasi, arahkan ke kunjungan WA TERBARU milik pemohon yang sama yang
        // masih menunggu_evaluasi, supaya tiap sesi dievaluasi sendiri (data tiap permintaan bisa beda).
        // Aman: token wa-eval-access sudah membuktikan kepemilikan salah satu kunjungan pemohon ini, jadi
        // resolve dibatasi same id_user + created_by='whatsapp' (mirror gerbang enqueue eval_link).
        $target = $id;
        if ($visit->status !== 'menunggu_evaluasi') {
            $cur = $this->db->select('id_kunjungan')
                ->where('id_user', $visit->id_user)
                ->where('created_by', 'whatsapp')
                ->where('status', 'menunggu_evaluasi')
                ->order_by('id_kunjungan', 'DESC')
                ->limit(1)
                ->get('tamdes_kunjungan')->row();
            if (!$cur) $this->json_response(['success' => false, 'message' => 'Evaluasi sudah selesai atau ditutup'], 409);
            $target = (int) $cur->id_kunjungan;
            $this->audit_system('wa_eval_redirect', 'visit', $target, ['from' => $id, 'id_user' => (int) $visit->id_user]);
        }

        $eval_token = $this->mint_kiosk_token('eval-submit', $target, 600); // short; used against UNCHANGED /api/evaluations/{id}
        $this->json_response(['success' => true, 'data' => ['id_kunjungan' => $target, 'kiosk_token' => $eval_token], 'message' => 'OK']);
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
        $this->require_role_in(['admin', 'superadmin']); // #11 — pairing is admin-only
        $in  = $this->get_json_input();
        $raw = preg_replace('/\D/', '', (string) ($in['phone'] ?? ''));
        if ($raw !== '' && strpos($raw, '0') === 0) $raw = '62' . substr($raw, 1); // 08xx → 628xx (internasional)
        $this->db->where('id', 1)->update('wa_qr_state', ['pair_phone' => ($raw !== '' ? $raw : null), 'pairing_code' => null]);
        $this->json_response(['success' => true, 'data' => ['pair_phone' => ($raw !== '' ? $raw : null)], 'message' => ($raw !== '' ? 'Meminta kode tautan…' : 'Dibatalkan')]);
    }

    /* ───────────────────────── private helpers ───────────────────────── */

    private function wa_dispatch_scan() {
        $now = date('Y-m-d H:i:s');

        // 1. Expire stale sessions (>48h awaiting_form or awaiting_category).
        $this->db->where_in('state', ['awaiting_form', 'awaiting_category'])
                 ->where('created_at <', date('Y-m-d H:i:s', time() - 48 * 3600))
                 ->update('wa_sessions', ['state' => 'expired']);

        // 1b. Expire stale group_notify (petugas ping). Sebuah "✅ Permintaan Data Online Masuk" yang
        //     telat berhari-hari = bising (sumber kebenaran ada di /admin/layanan-online), dan baris
        //     'pending' yang macet akan terkirim BASI saat connector restart. TTL configurable; default 6 jam.
        //     Hanya group_notify: confirmation/eval_link/thankyou punya dependensi hilir (dedup ledger,
        //     gerbang evaluasi) → jangan di-age-cap di sini. Lihat memo wa_outbox_stale_delivery.
        $g_ttl = (int) ($this->push_config('wa_outbox_group_ttl_secs') ?: 21600);
        $this->db->where('status', 'pending')->where('msg_type', 'group_notify')
                 ->where('created_at <', date('Y-m-d H:i:s', time() - $g_ttl))
                 ->update('wa_outbox', ['status' => 'failed']);
        $expired = $this->db->affected_rows();
        if ($expired > 0) {
            // Deteksi (anti-senyap): kalau ini berulang, akar masalahnya connector sering down/zombie
            // saat permintaan masuk (insiden 23–29 Jun) — bukan gejala outbox. Jejak queryable di audit log.
            log_message('error', "wa_outbox: expired {$expired} stale group_notify (TTL {$g_ttl}s)");
            $this->audit_system('wa_outbox_expire', 'wa_outbox', 0, ['count' => $expired, 'ttl_secs' => $g_ttl]);
        }

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
            $this->db->insert('wa_outbox', ['phone_raw' => $v->notel, 'wa_chat_id' => ($v->wa_chat_id ?: null), 'msg_type' => 'eval_link', 'body' => $body, 'id_kunjungan' => $idk, 'status' => 'pending']);
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
            $this->db->insert('wa_outbox', ['phone_raw' => $v->notel, 'wa_chat_id' => ($v->wa_chat_id ?: null), 'msg_type' => 'thankyou', 'body' => $body, 'id_kunjungan' => (int) $v->id_kunjungan, 'status' => 'pending']);
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

    // Buang anotasi peran dalam kurung dari nama operator untuk tampilan/pesan ke pengguna:
    // "Irma (Petugas PST)" → "Irma". Nama tanpa kurung tetap utuh.
    private function wa_strip_role_annot($nama) {
        $n = trim(preg_replace('/\s*\(.*\)\s*$/u', '', (string) $nama));
        return $n !== '' ? $n : 'Petugas';
    }
    // Nama operator (admin_users.nama, dibersihkan) untuk uid tertentu.
    private function wa_operator_name($uid) {
        $u = $this->db->select('nama')->get_where('admin_users', ['id' => (int) $uid])->row();
        return $u ? $this->wa_strip_role_annot($u->nama) : 'Petugas';
    }

    // Pesan menu kategori (balasan angka) — dikirim ke pemohon sebelum form apa pun.
    // nomor_antrian for a visit (null if none / not found) — surfaced in intake responses
    // so the web success ticket shows the QUEUE NUMBER (e.g. "P002") for #2 offline, not WA-{id}.
    private function wa_visit_nomor($idk) {
        if (!$idk) return null;
        $r = $this->db->select('nomor_antrian')->get_where('tamdes_kunjungan', ['id_kunjungan' => (int) $idk])->row();
        return $r ? $r->nomor_antrian : null;
    }

    private function jam_layanan_text() {
        return 'Senin–Kamis 08.00–15.30 WIT, Jumat 08.00–16.00 WIT';
    }

    private function wa_menu_text() {
        return "Selamat datang di Layanan Online BPS Maluku Utara 👋\n\n"
             . "Kami melayani *4 layanan statistik*: Perpustakaan, Konsultasi Statistik, "
             . "Rekomendasi Kegiatan Statistik, dan Penjualan Produk Statistik. Keempatnya bisa "
             . "Anda akses dengan *2 cara* — silakan balas *ANGKA*:\n\n"
             . "*1.* 📊 *Layanan Online (lewat chat ini)*\n"
             . "Ajukan salah satu dari 4 layanan di atas *secara online*: isi formulir singkat lewat "
             . "link (pilih layanan + tulis kebutuhan Anda), lalu petugas memproses & membalas di chat "
             . "ini — *tanpa perlu datang* ke kantor.\n\n"
             . "*2.* 🏢 *Daftar Antrian Offline (datang ke kantor)*\n"
             . "Layanan yang *sama*, tetapi Anda *akan datang langsung ke kantor* BPS. Daftar di sini "
             . "untuk mendapat *nomor antrian hari ini*, lalu cukup ke bagian *Resepsionis* untuk dilayani.\n\n"
             . "*3.* 💬 *Lainnya*\n"
             . "Pertanyaan umum atau keperluan lain di luar 4 layanan di atas.\n\n"
             . "_Balas 1, 2, atau 3 untuk melanjutkan._";
    }

    // Enqueue pesan ke PEMOHON (bukan grup). msg_type harus valid ENUM wa_outbox.
    private function wa_enqueue_user($phone_raw, $reply_to, $type, $body) {
        $this->db->insert('wa_outbox', ['phone_raw' => $phone_raw, 'wa_chat_id' => $reply_to, 'msg_type' => $type, 'body' => $body, 'status' => 'pending']);
    }

    private function wa_handle_category_choice($sess, $reply_to, $text) {
        $sid = (int) $sess->id;
        if ($text === '1') {
            $this->db->where('id', $sid)->update('wa_sessions', ['state' => 'awaiting_form', 'category' => 'data', 'link_sent_at' => date('Y-m-d H:i:s')]);
            $token = $this->mint_kiosk_token('wa-intake', $sid, 48 * 3600);
            $link  = $this->wa_public_base() . '/layanan-online/' . $sid . '?t=' . rawurlencode($token);
            $body  = "Baik 🙏 untuk *Layanan Online* (diproses langsung lewat chat ini).\n\n"
                   . "Buka tautan di bawah, lalu:\n"
                   . "• isi *data diri* Anda\n"
                   . "• *pilih layanan* yang dibutuhkan (Perpustakaan / Konsultasi Statistik / Rekomendasi Kegiatan Statistik / Penjualan Produk Statistik)\n"
                   . "• *pilih sarana* yang Anda gunakan\n"
                   . "• *tuliskan kebutuhan/permintaan* Anda\n\n"
                   . "Permintaan Anda akan kami proses pada jam layanan dan kami balas langsung di chat ini — *tanpa perlu datang* ke kantor.\n"
                   . "Jam layanan: " . $this->jam_layanan_text() . ".\n\n"
                   . "⏱️ Tautan berlaku 48 jam:\n" . $link . "\n\n"
                   . "_Salah pilih? Balas *0* untuk kembali ke menu._";
            $this->wa_enqueue_user($sess->phone_raw, $reply_to, 'intake_link', $body);
            return; // ping grup tetap saat submit (existing "Permintaan Data Online Masuk")
        }
        if ($text === '2') {
            $this->db->where('id', $sid)->update('wa_sessions', ['state' => 'awaiting_form', 'category' => 'offline', 'link_sent_at' => date('Y-m-d H:i:s')]);
            $token = $this->mint_kiosk_token('wa-intake', $sid, 48 * 3600);
            $link  = $this->wa_public_base() . '/layanan-online/' . $sid . '?t=' . rawurlencode($token);
            $body  = "Baik 🙏 untuk *Daftar Antrian Offline* (dilayani langsung di kantor).\n\n"
                   . "Buka tautan di bawah, lalu:\n"
                   . "• isi *data diri* Anda\n"
                   . "• *pilih layanan* yang dibutuhkan (Perpustakaan / Konsultasi Statistik / Rekomendasi Kegiatan Statistik / Penjualan Produk Statistik)\n\n"
                   . "Setelah dikirim, Anda langsung mendapat *nomor antrian untuk hari ini*. Tinggal datang ke Kantor BPS Provinsi Maluku Utara, ke bagian *Resepsionis*, untuk dilayani.\n"
                   . "Jam layanan: " . $this->jam_layanan_text() . ".\n\n"
                   . "⏱️ Tautan berlaku 48 jam:\n" . $link . "\n\n"
                   . "_Salah pilih? Balas *0* untuk kembali ke menu._";
            $this->wa_enqueue_user($sess->phone_raw, $reply_to, 'intake_link', $body);
            return;
        }
        if ($text === '3') {
            $this->wa_create_lainnya_visit($sess, $reply_to);
            return;
        }
        // Tidak dikenali → ulangi menu.
        $this->wa_enqueue_user($sess->phone_raw, $reply_to, 'menu', "Mohon balas dengan angka *1*, *2*, atau *3*.\n\n" . $this->wa_menu_text());
    }

    private function wa_create_lainnya_visit($sess, $reply_to) {
        $sid = (int) $sess->id;
        // Guard TOCTOU: kalau sudah submitted (balasan ganda), jangan buat visit kedua.
        $fresh = $this->db->select('state, id_kunjungan')->get_where('wa_sessions', ['id' => $sid])->row();
        if ($fresh && $fresh->state === 'submitted' && $fresh->id_kunjungan) return;

        $existing = $this->db->where('notel', $sess->phone_norm)->order_by('id_user', 'DESC')->limit(1)->get('tamdes_buku')->row();
        if ($existing) {
            $id_user = (int) $existing->id_user;
        } else {
            $max     = $this->db->select_max('id_user')->get('tamdes_buku')->row()->id_user;
            $id_user = $max ? $max + 1 : 8200001;
            $this->db->insert('tamdes_buku', ['id_user' => $id_user, 'nama' => ($this->wa_known_name($sess->phone_norm) ?: ''), 'notel' => $sess->phone_norm]);
        }
        $this->db->insert('tamdes_kunjungan', [
            'id_user' => $id_user, 'jenis_layanan' => json_encode(['Lainnya Online']), 'sarana' => json_encode([2]),
            'date_visit' => date('Y-m-d H:i:s'), 'status' => 'antri', 'nomor_antrian' => null, 'created_by' => 'whatsapp',
        ]);
        $idk = (int) $this->db->insert_id();
        $this->db->where('id', $sid)->update('wa_sessions', ['state' => 'submitted', 'category' => 'lainnya', 'id_kunjungan' => $idk, 'submitted_at' => date('Y-m-d H:i:s')]);

        $g    = $this->wa_known_name($sess->phone_norm) ?: 'Pemohon';
        $body = "✅ *PERMINTAAN ANDA DITERIMA*\n"
              . "Badan Pusat Statistik Provinsi Maluku Utara\n\n"
              . "• *Nomor Tiket:* WA-{$idk}\n"
              . "• *Nama:* {$g}\n"
              . "• *Kategori:* Lainnya\n"
              . "• *Tanggal:* " . date('d-m-Y') . "\n\n"
              . "Petugas kami akan menindaklanjuti dan membalas Anda langsung di chat ini pada jam operasional layanan.\n\n"
              . "🕒 *Jam Layanan*\n" . $this->jam_layanan_text() . "\n\n"
              . "_Butuh layanan/data statistik secara online? Balas *0* untuk kembali ke menu, lalu pilih *1*._\n\n"
              . "Terima kasih. 🙏";
        $this->wa_enqueue_user($sess->phone_raw, $reply_to, 'confirmation', $body);
        $this->wa_notify_group_enqueue("💬 *Lainnya — minta ditangani*\nNama: {$g}\nNomor: {$sess->phone_norm}\nTiket: WA-{$idk}\n" . $this->wa_public_base() . "/admin/layanan-online");
    }

    // Mitigasi salah kategori: alihkan sesi #2 (offline) atau #3 (lainnya) ke form Permintaan Data.
    // Dipanggil dari ingest() saat user balas "1" dengan sesi aktif offline/lainnya.
    private function wa_switch_to_data($sess, $reply_to) {
        $sid = (int) $sess->id;
        // Tidak bisa dialihkan kalau sudah check-in kiosk (sudah dilayani langsung) atau sudah selesai.
        if (!empty($sess->id_kunjungan)) {
            $v = $this->db->select('created_by,status')->get_where('tamdes_kunjungan', ['id_kunjungan' => (int) $sess->id_kunjungan])->row();
            if ($v && ($v->created_by === 'wa_kiosk' || in_array($v->status, ['selesai', 'evaluasi_selesai'], true))) {
                $this->wa_enqueue_user($sess->phone_raw, $reply_to, 'confirmation', "Mohon maaf 🙏 kunjungan Anda sudah diproses langsung sehingga tidak dapat dialihkan ke *Layanan Online*.\n\nUntuk mengajukan permintaan baru, balas *0* untuk membuka menu layanan.");
                return;
            }
        }
        // Alihkan: kategori → data, kembali ke awaiting_form (id_kunjungan dipertahankan untuk konversi saat submit).
        $this->db->where('id', $sid)->update('wa_sessions', ['state' => 'awaiting_form', 'category' => 'data', 'link_sent_at' => date('Y-m-d H:i:s')]);
        $token = $this->mint_kiosk_token('wa-intake', $sid, 48 * 3600);
        $link  = $this->wa_public_base() . '/layanan-online/' . $sid . '?t=' . rawurlencode($token);
        $body = "Baik 🙏 beralih ke *Layanan Online* (diproses langsung lewat chat ini).\n\n"
              . "Buka tautan di bawah, lalu:\n"
              . "• isi *data diri* Anda\n"
              . "• *pilih layanan* yang dibutuhkan (Perpustakaan / Konsultasi Statistik / Rekomendasi Kegiatan Statistik / Penjualan Produk Statistik)\n"
              . "• *pilih sarana* yang Anda gunakan\n"
              . "• *tuliskan kebutuhan/permintaan* Anda\n\n"
              . "Permintaan Anda akan kami proses pada jam layanan dan kami balas langsung di chat ini — *tanpa perlu datang* ke kantor.\n"
              . "Jam layanan: " . $this->jam_layanan_text() . ".\n\n"
              . "⏱️ Tautan berlaku 48 jam:\n" . $link . "\n\n"
              . "_Salah pilih? Balas *0* untuk kembali ke menu._";
        $this->wa_enqueue_user($sess->phone_raw, $reply_to, 'intake_link', $body);
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
        $body = "✅ *PERMINTAAN ANDA SELESAI*\n"
              . "Badan Pusat Statistik Provinsi Maluku Utara\n\n"
              . "Permintaan Anda telah selesai kami proses. Terima kasih telah menggunakan layanan BPS Provinsi Maluku Utara. 🙏\n\n"
              . "_Jika sewaktu-waktu membutuhkan layanan lagi, cukup balas pesan ini untuk memulai permintaan baru._\n\n"
              . "Salam hangat, semoga hari Anda menyenangkan 🙂";
        $this->db->insert('wa_outbox', [
            'phone_raw' => $info->notel, 'wa_chat_id' => ($info->wa_chat_id ?: null),
            'msg_type'  => 'closing', 'body' => $body, 'id_kunjungan' => $idk, 'status' => 'pending',
        ]);
    }

    /* ── live-chat helpers ── */

    private function wa_is_pst_role() {
        $role = $this->current_user->role ?? '';
        return in_array($role, ['petugas_pst', 'operator', 'admin', 'superadmin', 'pimpinan'], true);
    }

    // #5 — write-role set: excludes 'pimpinan' (read-only viewer tier). Reads keep wa_is_pst_role().
    private function wa_can_write() {
        $role = $this->current_user->role ?? '';
        return in_array($role, ['petugas_pst', 'operator', 'admin', 'superadmin'], true);
    }

    // #17 — a claimed session (assigned_to set) may only be written by its assignee; admin override.
    // Unclaimed sessions (or a null session) stay open to any write-role operator.
    private function wa_require_session_owner($sess) {
        if (!$sess) return;
        $assigned = (int) ($sess->assigned_to ?? 0);
        if ($assigned === 0) return;
        $uid  = (int) ($this->current_user->id ?? 0);
        $role = $this->current_user->role ?? '';
        if ($assigned === $uid) return;
        if (in_array($role, ['admin', 'superadmin'], true)) return;
        $this->json_response(['success' => false, 'message' => 'Sesi ini sedang ditangani operator lain.'], 403);
    }

    private function wa_media_dir() {
        $dir = FCPATH . 'assets/wa_media/';
        if (!is_dir($dir)) @mkdir($dir, 0775, true);
        return $dir;
    }

    // Klasifikasi tipe pesan dari mime (image/audio/video/document). 'sticker' ditentukan caller via hint.
    private function wa_media_type($mime) {
        if (strpos($mime, 'image/') === 0) return 'image';
        if (strpos($mime, 'audio/') === 0) return 'audio';
        if (strpos($mime, 'video/') === 0) return 'video';
        return 'document';
    }

    private function wa_mime_allowed($mime) {
        return in_array($mime, [
            'image/jpeg', 'image/png', 'image/webp', 'image/gif',
            'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr', 'audio/wav',
            'video/mp4', 'video/3gpp', 'video/quicktime', 'video/webm',
            'application/pdf', 'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ], true);
    }

    private function wa_ext_for_mime($mime) {
        $map = [
            'image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp', 'image/gif' => 'gif',
            'audio/ogg' => 'ogg', 'audio/mpeg' => 'mp3', 'audio/mp4' => 'm4a', 'audio/aac' => 'aac', 'audio/amr' => 'amr', 'audio/wav' => 'wav',
            'video/mp4' => 'mp4', 'video/3gpp' => '3gp', 'video/quicktime' => 'mov', 'video/webm' => 'webm',
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
               AND ( (s.state IN ('awaiting_category','awaiting_form') AND s.created_at > (NOW() - INTERVAL 48 HOUR))
                     OR (s.state = 'submitted' AND k.status IS NOT NULL AND k.status <> 'selesai') )
             ORDER BY s.id DESC LIMIT 1",
            [$phone_norm]
        )->row();
    }

    // Sesi terbaru untuk nomor (alamat balas + konteks) — petugas boleh kirim kapan pun.
    private function wa_latest_session($phone_norm) {
        return $this->db->select('id, wa_chat_id, id_kunjungan, assigned_to')->where('phone_norm', $phone_norm)
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
            'ack'        => (int) ($m->ack ?? 0),
            'reaction'       => $m->reaction ?? null,
            'quoted_msg_id'  => $m->quoted_msg_id ?? null,
            'quoted_preview' => $m->quoted_preview ?? null,
            'created_at' => $m->created_at,
        ];
    }
}
