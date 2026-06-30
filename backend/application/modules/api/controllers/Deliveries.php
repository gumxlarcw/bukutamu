<?php
defined('BASEPATH') or exit('No direct script access allowed');

require_once APPPATH . 'modules/api/controllers/Api_base.php';

class Deliveries extends Api_base
{
    // POST /api/deliveries  (multipart: id_kunjungan, id_konsultasi?, link_url?, note, file?)
    // GET  /api/deliveries  (paginated list with ?status=&id_kunjungan=)
    public function index()
    {
        $method = $this->input->method(true);
        if ($method === 'GET')  { return $this->_list(); }
        if ($method !== 'POST') { return $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405); }

        $this->require_auth();
        $this->require_role_in(['petugas_pst', 'operator', 'admin', 'superadmin']);

        $id_kunjungan  = (int) $this->input->post('id_kunjungan');
        $id_konsultasi = $this->input->post('id_konsultasi') ? (int) $this->input->post('id_konsultasi') : null;
        $link_url      = trim((string) $this->input->post('link_url'));
        $note          = trim((string) $this->input->post('note'));

        if ($id_kunjungan <= 0) {
            return $this->json_response(['success' => false, 'message' => 'id_kunjungan wajib'], 422);
        }

        // Optional file (same rules as wa upload: <=25MB, finfo MIME whitelist).
        $media = $this->_store_upload_if_present(); // returns ['path','mime','name'] or null; 422-bails on bad file
        if ($link_url === '' && $media === null) {
            return $this->json_response(['success' => false, 'message' => 'Sertakan link atau file'], 422);
        }

        $this->load->model('delivery_model');
        $id = $this->delivery_model->create([
            'id_kunjungan'  => $id_kunjungan,
            'id_konsultasi' => $id_konsultasi,
            'channel'       => 'online',
            'link_url'      => $link_url === '' ? null : $link_url,
            'media_path'    => $media['path'] ?? null,
            'media_mime'    => $media['mime']  ?? null,
            'media_name'    => $media['name']  ?? null,
            'note_operator' => $note === '' ? null : $note,
            'status'        => 'menunggu_verifikasi',
            'created_by'    => (int) $this->current_user->id,
        ]);
        $this->delivery_model->set_short_code($id);

        $this->_notify_verifier($id);

        $this->audit('delivery_create', 'delivery', $id);
        return $this->json_response(['success' => true, 'data' => $this->delivery_model->get($id), 'message' => 'OK'], 201);
    }

    // GET /api/deliveries/:id   → with_context (verifier card)
    // DELETE /api/deliveries/:id → cancel (status → dibatalkan; only pending or revisi)
    // (resubmit is its own POST endpoint — PHP doesn't populate $_POST/$_FILES on PUT)
    public function detail($id)
    {
        $id     = (int) $id;
        $method = $this->input->method(true);

        if ($method === 'GET') {
            $this->require_auth();
            $this->require_role_in(['petugas_pst', 'operator', 'verifikator', 'admin', 'superadmin']);
            $this->load->model('delivery_model');
            $row = $this->delivery_model->with_context($id);
            if (!$row) {
                return $this->json_response(['success' => false, 'message' => 'Tidak ditemukan'], 404);
            }
            return $this->json_response(['success' => true, 'data' => $row, 'message' => 'OK']);
        }

        if ($method === 'DELETE') {
            $this->require_auth();
            $this->require_role_in(['petugas_pst', 'operator', 'admin', 'superadmin']);

            $this->load->model('delivery_model');
            $row = $this->delivery_model->get($id);
            if (!$row) {
                return $this->json_response(['success' => false, 'message' => 'Tidak ditemukan'], 404);
            }
            if (!in_array($row->status, ['menunggu_verifikasi', 'revisi'], true)) {
                return $this->json_response(['success' => false, 'message' => 'Hanya pengiriman berstatus menunggu verifikasi atau revisi yang bisa dibatalkan'], 409);
            }
            $this->delivery_model->update($id, ['status' => 'dibatalkan']);
            $this->audit('delivery_cancel', 'delivery', $id, ['from' => $row->status]);
            return $this->json_response(['success' => true, 'data' => null, 'message' => 'Pengiriman dibatalkan']);
        }

        return $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
    }

    // POST /api/deliveries/:id/resubmit  (multipart: link_url?, note?, file?)
    // Operator edit & resubmit of a RETURNED (revisi) delivery. This is POST, not PUT,
    // because PHP does NOT populate $_POST/$_FILES on PUT — and resubmit carries a file.
    public function resubmit($id)
    {
        if ($this->input->method(true) !== 'POST') {
            return $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }
        $this->require_auth();
        $this->require_role_in(['petugas_pst', 'operator', 'admin', 'superadmin']);

        $id = (int) $id;
        $this->load->model('delivery_model');
        $row = $this->delivery_model->get($id);
        if (!$row) {
            return $this->json_response(['success' => false, 'message' => 'Tidak ditemukan'], 404);
        }
        if ($row->status !== 'revisi') {
            return $this->json_response(['success' => false, 'message' => 'Hanya pengiriman berstatus revisi yang bisa diperbaiki & dikirim ulang'], 409);
        }

        $link_url = trim((string) $this->input->post('link_url'));
        $note     = trim((string) $this->input->post('note'));
        $media    = $this->_store_upload_if_present(); // null, or ['path','mime','name']; 422-bails on bad file

        // Must still carry a deliverable: a link, a new file, or the pre-existing one.
        $has_media = ($media !== null) || ($row->media_path !== null && $row->media_path !== '');
        if ($link_url === '' && !$has_media) {
            return $this->json_response(['success' => false, 'message' => 'Sertakan link atau file'], 422);
        }

        $upd = [
            'link_url'       => $link_url === '' ? null : $link_url,
            'note_operator'  => $note === '' ? null : $note,
            'revisi_count'   => (int) $row->revisi_count + 1,
            'status'         => 'menunggu_verifikasi',
            'verif_decision' => null,
            'verif_note'     => null,
            'id_verifikator' => null,
            'verified_at'    => null,
        ];
        if ($media !== null) {
            $upd['media_path'] = $media['path'];
            $upd['media_mime'] = $media['mime'];
            $upd['media_name'] = $media['name'];
        }
        $this->delivery_model->update($id, $upd);

        $this->_notify_verifier($id);

        $this->audit('delivery_resubmit', 'delivery', $id, ['revisi_count' => $upd['revisi_count']]);
        return $this->json_response(['success' => true, 'data' => $this->delivery_model->get($id), 'message' => 'Pengiriman diperbaiki & dikirim ulang untuk verifikasi']);
    }

    // PUT /api/deliveries/:id/verify  {decision, note?}
    // Verifier decision → state machine in Delivery_model::apply_decision (shared with the
    // WA reply path, Task 6). On approval the model materializes a customer wa_messages row;
    // the WA connector (polls direction='out' AND status='pending') sends it. This method is
    // a thin web wrapper: auth + parse + delegate + audit.
    public function verify($id)
    {
        if ($this->input->method(true) !== 'PUT') {
            return $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }
        $this->require_auth();
        $this->require_role_in(['verifikator', 'admin', 'superadmin']);

        // PUT bodies are NOT in $this->input->post() — read the raw JSON body (mirror Visits::status).
        $input    = $this->get_json_input();
        $decision = (string) ($input['decision'] ?? '');
        $note     = isset($input['note']) ? (string) $input['note'] : null;

        if (!in_array($decision, ['setuju', 'revisi', 'setuju_catatan'], true)) {
            return $this->json_response(['success' => false, 'message' => 'decision tidak valid'], 422);
        }

        $this->load->model('delivery_model');
        $res = $this->delivery_model->apply_decision((int) $id, $decision, $note, (int) $this->current_user->id);

        // Audit lives in the caller — the model is pure DB ops. Only log applied decisions
        // (ok=true covers both 'terkirim' and the approved-but-unsent send_failed case).
        if ($res['ok']) {
            $this->audit('delivery_verify_' . $decision, 'delivery', (int) $id, ['status' => $res['status']]);
        }

        // Map the channel-agnostic reason → HTTP status (WA path uses the message instead).
        switch ($res['reason']) {
            case 'validation': $code = 422; break;
            case 'conflict':   $code = 409; break;
            case 'not_found':  $code = 404; break;
            case 'ok':
            case 'send_failed':
            default:           $code = 200; break;
        }

        return $this->json_response(
            ['success' => $res['ok'], 'data' => $this->delivery_model->get((int) $id), 'message' => $res['message']],
            $code
        );
    }

    // GET /api/deliveries/:id/file → stream the stored file (auth required)
    public function file($id)
    {
        $id = (int) $id;
        if ($this->input->method(true) !== 'GET') {
            return $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }
        $this->require_auth();
        $this->require_role_in(['petugas_pst', 'operator', 'verifikator', 'admin', 'superadmin']);

        $this->load->model('delivery_model');
        $row = $this->delivery_model->get($id);
        if (!$row || !$row->media_path) {
            return $this->json_response(['success' => false, 'message' => 'Tidak ditemukan'], 404);
        }

        // Path-traversal guard (mirror Wa::media)
        $dir  = $this->_wa_media_dir();
        $real = realpath($dir . basename($row->media_path));
        if ($real === false || strpos($real, realpath($dir)) !== 0 || !is_file($real)) {
            return $this->json_response(['success' => false, 'message' => 'File tidak ada'], 404);
        }

        $mime  = $row->media_mime ?: 'application/octet-stream';
        $disp  = (strpos($mime, 'image/') === 0 || strpos($mime, 'audio/') === 0 || strpos($mime, 'video/') === 0) ? 'inline' : 'attachment';
        $fname = str_replace(['"', "\r", "\n", '/', '\\'], '', ($row->media_name ?: basename($real)));

        while (ob_get_level() > 0) ob_end_clean();
        header('Content-Type: ' . $mime);
        header('Content-Length: ' . filesize($real));
        header('Content-Disposition: ' . $disp . '; filename="' . $fname . '"');
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: private, max-age=300');
        readfile($real);
        exit;
    }

    // ── private helpers ─────────────────────────────────────────────────────

    // Enqueue a formal verification-request message to the active verifier via wa_outbox.
    // Sets verif_outbox_id on the delivery so the WA reply handler (Task 6) can correlate.
    // Fails silently (error log only) when no active verifier with a phone number exists.
    private function _notify_verifier(int $id): void
    {
        $this->load->model('delivery_model');
        $v = $this->delivery_model->active_verifier();
        if (!$v || !$v->notel) {
            log_message('error', "delivery {$id}: no active verifier notel");
            return;
        }
        $d = $this->delivery_model->with_context($id);
        if (!$d) {
            log_message('error', "delivery {$id}: context not found for verifier notification");
            return;
        }

        // Build formal verifier message (no emoji, minimal whitespace).
        $pemohon_line = ($d->pemohon_nama ? trim((string) $d->pemohon_nama) : '-');
        if ($d->instansi) {
            $pemohon_line .= ' (' . $d->instansi . ')';
        }

        $parts = [];
        $parts[] = "Permohonan Verifikasi Data [{$d->short_code}]";
        $parts[] = '';
        $parts[] = 'Pemohon : ' . $pemohon_line;
        if ($d->nomor_antrian) {
            $parts[] = 'Antrian : ' . $d->nomor_antrian;
        }
        if ($d->rincian_data) {
            $data_line = 'Data    : ' . $d->rincian_data;
            if ($d->wilayah_data) {
                $data_line .= ' (' . $d->wilayah_data . ')';
            }
            $parts[] = $data_line;
        }
        $parts[] = '';
        $parts[] = 'Disiapkan operator:';
        if ($d->link_url) {
            $parts[] = '- Tautan : ' . $d->link_url;
        }
        if ($d->media_name) {
            $parts[] = '- Berkas : ' . $d->media_name . ' (tinjau di panel verifikasi)';
        }
        if ($d->note_operator) {
            $parts[] = '- Catatan: ' . $d->note_operator;
        }
        $parts[] = '';
        $parts[] = 'Balas untuk memberi keputusan:';
        $parts[] = '1 = Setuju (kirim ke pemohon)';
        $parts[] = '2 = Revisi disertai catatan (mis. "2 tahun 2023 belum ada")';
        $parts[] = '3 = Setuju dengan tambahan catatan';
        $body = implode("\n", $parts);

        $this->db->insert('wa_outbox', [
            'phone_raw'    => $v->notel,
            // Format notel (08…/62…/+62…) → WA jid: connector sends to wa_chat_id verbatim,
            // so a bare "08…" number would fail. Strip non-digits, leading 0 → 62, add @c.us.
            'wa_chat_id'   => preg_replace('/^0/', '62', preg_replace('/\D/', '', (string) $v->notel)) . '@c.us',
            'msg_type'     => 'verif_request',
            'body'         => $body,
            'id_kunjungan' => (int) $d->id_kunjungan,
            'status'       => 'pending',
        ]);
        $this->delivery_model->update($id, ['verif_outbox_id' => (int) $this->db->insert_id()]);
    }

    private function _list()
    {
        $this->require_auth();
        $this->require_role_in(['petugas_pst', 'operator', 'verifikator', 'admin', 'superadmin']);

        $status       = $this->input->get('status');
        $id_kunjungan = $this->input->get('id_kunjungan');
        $page         = max(1, (int) $this->input->get('page') ?: 1);
        $limit        = max(1, min(100, (int) $this->input->get('limit') ?: 20));

        $filters = [];
        if ($status)       $filters['status']       = $status;
        if ($id_kunjungan) $filters['id_kunjungan'] = (int) $id_kunjungan;

        $this->load->model('delivery_model');
        $result = $this->delivery_model->list_filtered($filters, $page, $limit);
        $total  = $result['total'];

        return $this->json_response([
            'success'    => true,
            'data'       => $result['rows'],
            'message'    => 'OK',
            'pagination' => [
                'page'       => $page,
                'limit'      => $limit,
                'total'      => $total,
                'totalPages' => (int) ceil($total / $limit),
            ],
        ]);
    }

    // Store uploaded file to wa_media/ (same dir as Wa.php — Task 4 reuses by path).
    // Returns ['path','mime','name'] on success, null if no file, or sends 422 + exits on bad upload.
    private function _store_upload_if_present()
    {
        if (empty($_FILES['file']) || ($_FILES['file']['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_NO_FILE) {
            return null;
        }
        $f = $_FILES['file'];
        if ($f['error'] !== UPLOAD_ERR_OK) {
            $this->json_response(['success' => false, 'message' => 'File gagal diupload'], 422);
        }
        if ($f['size'] > 25 * 1024 * 1024) {
            $this->json_response(['success' => false, 'message' => 'File melebihi 25MB'], 422);
        }

        // finfo is authoritative — do NOT trust $_FILES['type']
        $mime = $this->_detect_mime($f['tmp_name']);
        if (!$this->_mime_allowed($mime)) {
            $this->json_response(['success' => false, 'message' => 'Tipe file tidak diizinkan'], 422);
        }

        $name = bin2hex(random_bytes(16)) . '.' . $this->_ext_for_mime($mime);
        $dest = $this->_wa_media_dir() . $name;
        if (!move_uploaded_file($f['tmp_name'], $dest)) {
            $this->json_response(['success' => false, 'message' => 'Gagal menyimpan file'], 500);
        }
        @chmod($dest, 0644);

        return [
            'path' => $name,
            'mime' => $mime,
            'name' => mb_substr((string) ($f['name'] ?? $name), 0, 200),
        ];
    }

    // Same directory as Wa.php — deliberate (Task 4 inserts a wa_messages row pointing here).
    private function _wa_media_dir()
    {
        $dir = FCPATH . 'assets/wa_media/';
        if (!is_dir($dir)) @mkdir($dir, 0775, true);
        return $dir;
    }

    private function _detect_mime($path)
    {
        if (function_exists('finfo_open')) {
            $fi = finfo_open(FILEINFO_MIME_TYPE);
            if ($fi) { $m = finfo_file($fi, $path); finfo_close($fi); if ($m) return $m; }
        }
        return '';
    }

    private function _mime_allowed($mime)
    {
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

    private function _ext_for_mime($mime)
    {
        $map = [
            'image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp', 'image/gif' => 'gif',
            'audio/ogg'  => 'ogg', 'audio/mpeg' => 'mp3', 'audio/mp4' => 'm4a', 'audio/aac' => 'aac',
            'audio/amr'  => 'amr', 'audio/wav' => 'wav',
            'video/mp4'  => 'mp4', 'video/3gpp' => '3gp', 'video/quicktime' => 'mov', 'video/webm' => 'webm',
            'application/pdf'      => 'pdf', 'application/msword' => 'doc',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document' => 'docx',
            'application/vnd.ms-excel' => 'xls',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' => 'xlsx',
        ];
        return $map[$mime] ?? 'bin';
    }
}
