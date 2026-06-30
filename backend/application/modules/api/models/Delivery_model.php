<?php
defined('BASEPATH') or exit('No direct script access allowed');

class Delivery_model extends CI_Model
{
    public function create(array $data): int
    {
        $this->db->insert('data_deliveries', $data);
        return (int) $this->db->insert_id();
    }

    public function set_short_code(int $id): void
    {
        $this->db->where('id', $id)->update('data_deliveries', ['short_code' => 'V' . $id]);
    }

    public function get(int $id)
    {
        return $this->db->where('id', $id)->get('data_deliveries')->row();
    }

    public function update(int $id, array $data): bool
    {
        return (bool) $this->db->where('id', $id)->update('data_deliveries', $data);
    }

    // Return the first active verifier with a phone number, ordered by id ASC.
    // Phase 1 assumes a single verifier; multi-verifier routing is future (spec §13).
    public function active_verifier()
    {
        return $this->db->select('id, notel')->from('admin_users')
            ->where('role', 'verifikator')->where('active', 1)
            ->where('notel IS NOT NULL', null, false)
            ->order_by('id', 'ASC')->limit(1)->get()->row();
    }

    // Raw notel strings of every active verifikator. The CALLER normalizes both sides
    // (notel is stored as the admin typed it, e.g. 08…/+62…), so this returns the values
    // verbatim — no SQL string-munging. Used by the WA reply fast-path to decide "is this
    // sender a verifier?". Phase 1 is single-verifier; this still scans all of them.
    public function verifier_notels(): array
    {
        $rows = $this->db->select('notel')->from('admin_users')
            ->where('role', 'verifikator')->where('active', 1)
            ->where('notel IS NOT NULL', null, false)->get()->result();
        return array_map(function ($r) { return (string) $r->notel; }, $rows);
    }

    // Oldest pending verification first — the WA FIFO mapping (single-verifier Phase 1).
    // Returns the row or null when nothing is waiting.
    public function oldest_pending_for_verifier()
    {
        return $this->db->where('status', 'menunggu_verifikasi')
            ->order_by('created_at', 'ASC')->limit(1)->get('data_deliveries')->row();
    }

    // A specific still-pending delivery by its short_code (e.g. 'V37'); null if it does not
    // exist or is no longer 'menunggu_verifikasi' (already processed).
    public function by_short_code(string $code)
    {
        return $this->db->where('short_code', $code)->where('status', 'menunggu_verifikasi')
            ->limit(1)->get('data_deliveries')->row();
    }

    // Oldest pending first — used by the verifier queue AND the WA FIFO mapping.
    // Carries the same context JOINs as with_context() so callers get the full verifier-card
    // shape without a second round-trip. All JOINs are LEFT (1:1) — no fan-out, count stays
    // equal to the number of deliveries. count_all_results('', false) MUST stay BEFORE
    // order_by/limit/get() so the QB state is preserved for the paginated fetch.
    public function list_filtered(array $f, int $page, int $limit): array
    {
        $this->db->select('d.*, k.nomor_antrian, b.nama AS pemohon_nama, b.nama_instansi AS instansi, b.notel AS pemohon_notel, kp.rincian_data, kp.wilayah_data, kp.tahun_awal, kp.tahun_akhir, kp.status_data')
            ->from('data_deliveries d')
            ->join('tamdes_kunjungan k',       'k.id_kunjungan = d.id_kunjungan', 'left')
            ->join('tamdes_buku b',            'b.id_user = k.id_user',           'left')
            ->join('konsultasi_pengunjung kp', 'kp.id = d.id_konsultasi',         'left');
        if (!empty($f['status']))       $this->db->where('d.status', $f['status']);
        if (!empty($f['id_kunjungan'])) $this->db->where('d.id_kunjungan', (int) $f['id_kunjungan']);
        $total = $this->db->count_all_results('', false); // keep query for the page fetch
        $rows  = $this->db->order_by('d.created_at', 'ASC')
            ->limit($limit, ($page - 1) * $limit)->get()->result();
        return ['rows' => $rows, 'total' => (int) $total];
    }

    // Joined context for the verifier card: guest + the requested-data line.
    // Schema note: tamdes_buku uses nama_instansi (not instansi).
    public function with_context(int $id)
    {
        $this->db->select('d.*, k.nomor_antrian, k.id_user, b.nama AS pemohon_nama, b.nama_instansi AS instansi, b.notel AS pemohon_notel,
                           kp.rincian_data, kp.wilayah_data, kp.tahun_awal, kp.tahun_akhir, kp.status_data')
            ->from('data_deliveries d')
            ->join('tamdes_kunjungan k',    'k.id_kunjungan = d.id_kunjungan', 'left')
            ->join('tamdes_buku b',         'b.id_user = k.id_user',           'left')
            ->join('konsultasi_pengunjung kp', 'kp.id = d.id_konsultasi',      'left')
            ->where('d.id', $id);
        return $this->db->get()->row();
    }

    // Resolve the customer's WA reply address from the latest session of a visit.
    // Mirrors Wa::wa_latest_session (order by id DESC, limit 1) but keyed on id_kunjungan.
    // Also returns pemohon_nama (guest nama) via tamdes_kunjungan → tamdes_buku for the
    // formal delivery caption; LEFT JOINs so a missing guest row never drops the address.
    public function customer_addr(int $id_kunjungan)
    {
        return $this->db->select('s.phone_norm, s.wa_chat_id, b.nama AS pemohon_nama')
            ->from('wa_sessions s')
            ->join('tamdes_kunjungan k', 'k.id_kunjungan = s.id_kunjungan', 'left')
            ->join('tamdes_buku b',      'b.id_user = k.id_user',            'left')
            ->where('s.id_kunjungan', $id_kunjungan)
            ->order_by('s.id', 'DESC')->limit(1)->get()->row();
    }

    // Returns the new row id on success, or FALSE if the insert failed. Mirrors
    // Wa::wa_store (db_debug off → insert() can fail silently and return false; never
    // claim a row was written when it wasn't).
    public function insert_wa_message(array $row)
    {
        $ok = $this->db->insert('wa_messages', $row);
        if ($ok === false) {
            return false;
        }
        return (int) $this->db->insert_id();
    }

    // Shared verification state machine — web (Deliveries::verify) AND the WA reply
    // path (Task 6) both call this, so they can NEVER drift. PURE DB ops: the CALLER
    // is responsible for auditing. Channel-agnostic return so the HTTP caller maps
    // reason→status code and the WA path uses the message:
    //   ['ok'=>bool, 'reason'=>string, 'status'=>?string, 'message'=>string, 'short_code'=>?string]
    //   reason ∈ {'ok','validation','conflict','not_found','send_failed'}
    //
    // TOCTOU-safe: the decision is an ATOMIC CONDITIONAL CLAIM — a single
    // `WHERE status='menunggu_verifikasi'` UPDATE whose affected_rows() is the guard,
    // NOT a read-then-write. Two concurrent verifiers (or a web + WA double-fire) can
    // never both win, so we never double-send.
    public function apply_decision(int $id, string $decision, ?string $note, int $verifikator_id): array
    {
        // $d is fetched ONLY for short_code / not-found / validation — its status is
        // NOT the guard (the conditional claim below is).
        $d = $this->get($id);
        if (!$d) {
            return ['ok' => false, 'reason' => 'not_found', 'status' => null, 'message' => 'Pengiriman tidak ditemukan', 'short_code' => null];
        }

        $note = $note !== null ? trim($note) : null;
        if ($decision === 'revisi' && ($note === null || $note === '')) {
            return ['ok' => false, 'reason' => 'validation', 'status' => $d->status, 'message' => 'Revisi wajib menyertakan catatan', 'short_code' => $d->short_code];
        }

        $now = date('Y-m-d H:i:s');

        if ($decision === 'revisi') {
            $this->db->where('id', $id)->where('status', 'menunggu_verifikasi')->update('data_deliveries', [
                'status'         => 'revisi',
                'verif_decision' => 'revisi',
                'verif_note'     => $note,
                'id_verifikator' => $verifikator_id,
                'verified_at'    => $now,
            ]);
            if ($this->db->affected_rows() !== 1) {
                // Lost the race — another call already processed it. Do NOT materialize.
                return ['ok' => false, 'reason' => 'conflict', 'status' => $d->status, 'message' => "{$d->short_code} sudah diproses", 'short_code' => $d->short_code];
            }
            return ['ok' => true, 'reason' => 'ok', 'status' => 'revisi', 'message' => "{$d->short_code} dikembalikan ke operator", 'short_code' => $d->short_code];
        }

        // setuju | setuju_catatan → claim 'disetujui', materialize the customer message,
        // mark 'terkirim'. The whole approve sequence is atomic: never a 'terkirim' with
        // no message row, and the claim is rolled back if a write in the tx errors.
        $this->db->trans_begin();

        $this->db->where('id', $id)->where('status', 'menunggu_verifikasi')->update('data_deliveries', [
            'status'         => 'disetujui',
            'verif_decision' => $decision,
            'verif_note'     => ($decision === 'setuju_catatan' ? $note : null),
            'id_verifikator' => $verifikator_id,
            'verified_at'    => $now,
        ]);
        if ($this->db->affected_rows() !== 1) {
            // Lost the race — do NOT materialize (this is what prevents the double-send).
            $this->db->trans_rollback();
            return ['ok' => false, 'reason' => 'conflict', 'status' => $d->status, 'message' => "{$d->short_code} sudah diproses", 'short_code' => $d->short_code];
        }

        $sent = $this->materialize($id); // inserts the customer wa_messages row; bool

        if ($sent) {
            $this->db->where('id', $id)->update('data_deliveries', ['status' => 'terkirim']);
        }

        if ($this->db->trans_status() === FALSE) {
            // A write in the transaction failed (db_debug off → silent). Roll back so we
            // never commit a false 'terkirim' or a half-applied claim.
            $this->db->trans_rollback();
            return ['ok' => false, 'reason' => 'conflict', 'status' => null, 'message' => 'Gagal menyimpan keputusan verifikasi (transaksi dibatalkan). Silakan coba lagi.', 'short_code' => $d->short_code];
        }
        $this->db->trans_commit();

        if ($sent) {
            return ['ok' => true, 'reason' => 'ok', 'status' => 'terkirim', 'message' => "{$d->short_code} disetujui & dikirim ke pemohon", 'short_code' => $d->short_code];
        }
        // Approved, but no customer WA address → keep 'disetujui', surface send-failed.
        return ['ok' => true, 'reason' => 'send_failed', 'status' => 'disetujui', 'message' => "{$d->short_code} disetujui, tetapi belum terkirim (alamat WhatsApp pemohon tidak ditemukan)", 'short_code' => $d->short_code];
    }

    // Insert ONE customer-facing wa_messages row (direction=out, status=pending) so the
    // WA connector (polls direction='out' AND status='pending') sends it. Re-reads the row
    // AFTER apply_decision's approve update so verif_decision/verif_note are current.
    // Returns TRUE only when a row was actually inserted; FALSE (caller must NOT advance to
    // 'terkirim') when there is no customer WA address OR the insert failed.
    private function materialize(int $id): bool
    {
        $d = $this->get($id);
        if (!$d) return false;

        $addr = $this->customer_addr((int) $d->id_kunjungan);
        if (!$addr) {
            log_message('error', "delivery {$id}: no wa address for kunjungan {$d->id_kunjungan}");
            return false;
        }

        // Formal customer delivery caption (user-approved template).
        // {nama} = pemohon_nama from customer_addr; fall back to 'Bapak/Ibu' if absent.
        // Optional lines (note_operator, link_url, verif catatan) are fully omitted when
        // empty — no doubled blank lines.
        $nama_display = ($addr->pemohon_nama && trim((string) $addr->pemohon_nama) !== '')
            ? trim((string) $addr->pemohon_nama) : 'Bapak/Ibu';

        $caption_lines = [];
        $caption_lines[] = "Yth. {$nama_display},";
        $caption_lines[] = '';
        $caption_lines[] = 'Berikut data yang Bapak/Ibu minta:';
        if ($d->note_operator && trim((string) $d->note_operator) !== '') {
            $caption_lines[] = trim((string) $d->note_operator);
        }
        if ($d->link_url) {
            $caption_lines[] = $d->link_url;
        }
        $caption_lines[] = '';
        if ($d->verif_decision === 'setuju_catatan' && $d->verif_note) {
            $caption_lines[] = 'Catatan: ' . $d->verif_note;
            $caption_lines[] = '';
        }
        $caption_lines[] = 'Terima kasih telah menggunakan layanan';
        $caption_lines[] = 'PST BPS Maluku Utara.';
        $caption = implode("\n", $caption_lines);

        $base = [
            'phone_norm'   => $addr->phone_norm,
            'wa_chat_id'   => $addr->wa_chat_id,
            'id_kunjungan' => (int) $d->id_kunjungan,
            'direction'    => 'out',
            'status'       => 'pending',
        ];

        if ($d->media_path) {
            $type = strpos((string) $d->media_mime, 'image/') === 0 ? 'image' : 'document';
            $new_id = $this->insert_wa_message($base + [
                'msg_type'   => $type,
                'body'       => $caption,
                'media_path' => $d->media_path,
                'media_mime' => $d->media_mime,
                'media_name' => $d->media_name,
            ]);
        } else {
            $new_id = $this->insert_wa_message($base + [
                'msg_type' => 'text',
                'body'     => $caption,
            ]);
        }

        return $new_id !== false;
    }
}
