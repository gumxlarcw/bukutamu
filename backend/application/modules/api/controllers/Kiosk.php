<?php
defined('BASEPATH') OR exit('No direct script access allowed');

require_once APPPATH . 'modules/api/controllers/Api_base.php';

class Kiosk extends Api_base {

    public function face_data() {
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        // Rate-limit this enumeration endpoint. Normal kiosk fetches once per
        // page-load → way under 30/min. Scrapers get 429'd after a few bursts.
        // Not a hard perimeter (only Apache-level IP allowlist is); just slows
        // mass extraction of names + face descriptors.
        $this->require_rate_limit('kiosk/face-data', 30);

        $guests = $this->db
            ->select('id_user, nama, face_descriptor')
            ->from('tamdes_buku')
            ->where('face_descriptor IS NOT NULL', null, false)
            ->where('face_descriptor !=', '')
            ->get()->result();

        foreach ($guests as $guest) {
            if ($guest->face_descriptor) {
                $guest->face_descriptor = json_decode($guest->face_descriptor, true);
            }
        }

        $this->json_response(['success' => true, 'data' => $guests, 'message' => 'OK']);
    }

    public function guest_list() {
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        // Same rate-limit as face-data — both endpoints return the full guest set.
        $this->require_rate_limit('kiosk/guest-list', 30);

        $guests = $this->db
            ->select('id_user, nama, nama_instansi')
            ->from('tamdes_buku')
            ->order_by('nama', 'ASC')
            ->get()->result();

        $this->json_response(['success' => true, 'data' => $guests, 'message' => 'OK']);
    }

    public function register() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        // Anti-flood on this public no-auth endpoint: cap mass fake registrations
        // per IP. The nama+notel/day dedup below handles honest double-taps; this
        // trips only on scripted floods. 30/min matches the kiosk read endpoints
        // and dwarfs any real check-in rate (one device handles a few per minute).
        $this->require_rate_limit('kiosk/register', 30);

        $input = $this->get_json_input();

        // Strategy C: tolak cross layanan
        $this->validate_no_cross_layanan($input['jenis_layanan'] ?? null);
        $this->validate_sarana_for_layanan($input['jenis_layanan'] ?? null, $input['sarana'] ?? []);

        // Phone = cross-channel identity key. Canonicalize ONCE (mirror Wa::session) and
        // reuse the SAME value for the double-tap guard, the reuse lookup, and the stored
        // notel column. normalize_phone('') === '' -> treated as "no phone".
        $phone_norm = $this->normalize_phone($input['notel'] ?? '');

        // Prevent double-submit: same nama + canonical phone registered today -> return
        // existing visit. Canonical compare so the guard keeps firing after a reuse bumps
        // a returning guest's tgldatang to today. Only when a phone is present: with an
        // empty phone the predicate degenerates to nama+''+today and would merge two
        // different phoneless same-name visitors onto one visit (a phoneless double-tap
        // instead gets a recoverable duplicate).
        $recent = ($phone_norm !== '')
            ? $this->db->where('nama', $input['nama'] ?? '')
                       ->where('notel', $phone_norm)
                       ->where('tgldatang', date('Y-m-d'))
                       ->order_by('id_user', 'DESC')
                       ->get('tamdes_buku')->row()
            : null;
        if ($recent) {
            // Already has a PHYSICAL visit today (honest double-tap) — return it. Exclude
            // 'whatsapp' inbox visits: a WA registrant who came today must fall through to
            // the reuse/promote path below (convert their inbox visit), not get it back as-is.
            $existing_visit = $this->db->where('id_user', $recent->id_user)
                                       ->where_not_in('created_by', ['whatsapp'])
                                       ->order_by('id_kunjungan', 'DESC')
                                       ->get('tamdes_kunjungan')->row();
            if ($existing_visit) {
                $this->json_response([
                    'success' => true,
                    'data'    => ['id_kunjungan' => $existing_visit->id_kunjungan, 'id_user' => $recent->id_user, 'nomor_antrian' => $existing_visit->nomor_antrian],
                    'message' => 'Pendaftaran berhasil',
                ], 201);
            }
        }

        // Handle photo: base64 decode if provided (before the lock so both the
        // reuse-enroll and the new-guest insert can use it; less time under lock).
        $foto = null;
        if (!empty($input['foto'])) {
            // Strip data URI prefix if present
            $b64  = preg_replace('/^data:image\/\w+;base64,/', '', $input['foto']);
            $foto = base64_decode($b64);
        }

        // Lock guest/visit tables: the cross-channel reuse decision AND the id_user
        // allocation must both be TOCTOU-safe under concurrent first-time check-ins
        // (mirror Wa::session lock set + order). The reuse SELECT runs INSIDE the lock on
        // the already WRITE-locked tamdes_buku — never reference a table outside this set.
        $this->db->query('LOCK TABLES tamdes_buku WRITE, tamdes_kunjungan WRITE, tamdes_responden_tahunan WRITE');

        // ── Cross-channel reuse (phone = unique identity key) ───────────────────
        // A person already in tamdes_buku (from WhatsApp, or a prior offline/admin
        // registration) must be REUSED, not duplicated. We only reach register() because
        // face recognition did NOT match an enrolled face, so reuse is tightly gated:
        //   • phone non-empty (never look up on '' — it would match every blank notel),
        //   • EXACTLY ONE guest holds that number (unambiguous identity; a shared/reused
        //     number -> new guest, mirror the WA prefill/wa_lookup multi-match guard),
        //   • that guest has NO face on file. A face already enrolled means a different/
        //     changed face just failed to match -> treat as a different person -> new
        //     guest; never blind-overwrite a stored biometric/consent.
        // Additive only: the new visit points at an existing id_user; no guest row is
        // merged or deleted, so a mistake is recoverable by repointing one FK.
        $id_user = null;
        $promote_idk = null;  // open WhatsApp visit to promote in place (no dangling inbox row)
        if ($phone_norm !== '') {
            $cands = $this->db->select('id_user, nama, email, jeniskelamin, umur, disabilitas, jenis_disabilitas, pendidikan, pekerjaan, pekerjaan_lainnya, kategori_instansi, kategori_lainnya, nama_instansi, pemanfaatan, pemanfaatan_lainnya, pengaduan, face_descriptor')
                              ->where('notel', $phone_norm)
                              ->order_by('id_user', 'DESC')
                              ->limit(2)
                              ->get('tamdes_buku')->result();
            // Reuse needs an unverified TYPED phone to also agree on identity: require a
            // non-empty, case-insensitive nama match. Phone alone is not proof of ownership
            // at a kiosk (shared/mistyped/reassigned numbers), and a face is being enrolled
            // here — a name mismatch falls through to a NEW guest (safe: a recoverable
            // duplicate, never a wrong-person biometric merge). On WhatsApp the phone is
            // proven by the inbound message, which is why that side can key on phone alone.
            $typed_nama = trim((string) ($input['nama'] ?? ''));
            if (count($cands) === 1
                && trim((string) $cands[0]->face_descriptor) === ''
                && $typed_nama !== ''
                && mb_strtolower($typed_nama) === mb_strtolower(trim((string) $cands[0]->nama))) {
                // REUSE: enroll the onsite face onto the empty slot; fill-empties-only on
                // demographics (never clobber a non-empty field; never touch nama/notel).
                // tgldatang -> today so the same-day double-tap guard fires on a repeat.
                $cand    = $cands[0];
                $id_user = (int) $cand->id_user;

                $reuse = ['tgldatang' => date('Y-m-d')];
                if (isset($input['face_descriptor'])) {
                    $reuse['face_descriptor']   = json_encode($input['face_descriptor']);
                    $reuse['biometric_consent'] = !empty($input['biometric_consent']) ? 1 : 0;
                    $reuse['consent_timestamp'] = !empty($input['consent_timestamp']) ? date('Y-m-d H:i:s', strtotime($input['consent_timestamp'])) : date('Y-m-d H:i:s');
                    if ($foto !== null) $reuse['foto'] = $foto;
                }
                $fill       = ['email', 'jeniskelamin', 'umur', 'disabilitas', 'jenis_disabilitas', 'pendidikan', 'pekerjaan', 'pekerjaan_lainnya', 'kategori_instansi', 'kategori_lainnya', 'nama_instansi', 'pemanfaatan', 'pemanfaatan_lainnya', 'pengaduan'];
                $int_fields = ['umur', 'disabilitas', 'jenis_disabilitas'];
                foreach ($fill as $f) {
                    $cur = $cand->$f ?? null;
                    $new = $input[$f] ?? null;
                    if (($cur === null || $cur === '' || $cur === 0 || $cur === '0') && $new !== null && $new !== '') {
                        $reuse[$f] = in_array($f, $int_fields, true) ? (int) $new : $new;
                    }
                }
                $ok = $this->db->where('id_user', $id_user)->update('tamdes_buku', $reuse);
                if ($ok === false) {
                    $err = $this->db->error();
                    $this->db->query('UNLOCK TABLES');
                    log_message('error', 'Kiosk::register reuse update failed (id_user=' . $id_user . '): ' . print_r($err, true));
                    $this->json_response(['success' => false, 'message' => 'Gagal memperbarui data tamu (database error). Silakan coba lagi atau hubungi petugas.'], 500);
                }

                // If this WA guest still has an OPEN WhatsApp visit (they used the form
                // instead of the "Sudah Daftar via WhatsApp" button), promote THAT visit in
                // place below instead of inserting a second one — otherwise the original
                // dangles in the Layanan Online inbox.
                $wa_open = $this->db->select('id_kunjungan')
                                    ->where('id_user', $id_user)
                                    ->where('created_by', 'whatsapp')
                                    ->where_not_in('status', ['selesai', 'evaluasi_selesai'])
                                    ->order_by('id_kunjungan', 'DESC')->limit(1)
                                    ->get('tamdes_kunjungan')->row();
                if ($wa_open) $promote_idk = (int) $wa_open->id_kunjungan;
            }
        }

        // ── New guest (no reuse) ────────────────────────────────────────────────
        if ($id_user === null) {
            $max     = $this->db->select_max('id_user')->get('tamdes_buku')->row()->id_user;
            $id_user = $max ? $max + 1 : 8200001;

            $guest_data = [
                'id_user'              => $id_user,
                'nama'                 => $input['nama'] ?? '',
                'email'                => $input['email'] ?? '',
                'notel'                => $phone_norm,
                'jeniskelamin'         => $input['jeniskelamin'] ?? '',
                'umur'                 => !empty($input['umur']) ? (int)$input['umur'] : null,
                'disabilitas'          => !empty($input['disabilitas']) ? (int)$input['disabilitas'] : null,
                'jenis_disabilitas'    => !empty($input['jenis_disabilitas']) ? (int)$input['jenis_disabilitas'] : null,
                'pendidikan'           => $input['pendidikan'] ?? '',
                'pekerjaan'            => $input['pekerjaan'] ?? '',
                'pekerjaan_lainnya'    => $input['pekerjaan_lainnya'] ?? null,
                'kategori_instansi'    => $input['kategori_instansi'] ?? '',
                'kategori_lainnya'     => $input['kategori_lainnya'] ?? null,
                'nama_instansi'        => $input['nama_instansi'] ?? '',
                'pemanfaatan'          => $input['pemanfaatan'] ?? '',
                'pemanfaatan_lainnya'  => $input['pemanfaatan_lainnya'] ?? null,
                'pengaduan'            => $input['pengaduan'] ?? '',
                'foto'                 => $foto,
                'face_descriptor'      => isset($input['face_descriptor']) ? json_encode($input['face_descriptor']) : null,
                'tgldatang'            => date('Y-m-d'),
                'biometric_consent'    => !empty($input['biometric_consent']) ? 1 : 0,
                'consent_timestamp'    => !empty($input['consent_timestamp']) ? date('Y-m-d H:i:s', strtotime($input['consent_timestamp'])) : null,
                'registered_via'       => 'kiosk',
            ];

            $this->db->insert('tamdes_buku', $guest_data);
            if ($this->db->affected_rows() < 1) {
                // First insert silently failed (NOT NULL violation, charset issue, etc.) —
                // surface a real 500 instead of letting the FE redirect to /kiosk/ticket/0.
                $err = $this->db->error();
                $this->db->query('UNLOCK TABLES');
                log_message('error', 'Kiosk::register tamdes_buku insert failed: ' . print_r($err, true));
                $this->json_response([
                    'success' => false,
                    'message' => 'Gagal mendaftarkan tamu (database error). Silakan coba lagi atau hubungi petugas.',
                ], 500);
            }
        }

        // Insert visit — jenis_layanan & sarana stored as JSON arrays
        $jenis_layanan_raw = $input['jenis_layanan'] ?? '';
        $jenis_layanan = is_array($jenis_layanan_raw) ? json_encode($jenis_layanan_raw) : $jenis_layanan_raw;
        $nomor_antrian = $this->generate_queue_number(is_array($jenis_layanan_raw) ? ($jenis_layanan_raw[0] ?? '') : $jenis_layanan_raw);

        $sarana_raw = $input['sarana'] ?? [];
        $sarana = is_array($sarana_raw) ? json_encode($sarana_raw) : $sarana_raw;

        $visit_data = [
            'jenis_layanan'      => $jenis_layanan,
            'layanan_lainnya'    => $input['layanan_lainnya'] ?? null,
            'sarana'             => $sarana,
            'sarana_lainnya'     => $input['sarana_lainnya'] ?? null,
            'date_visit'         => date('Y-m-d H:i:s'),
            'status'             => 'antri',
            'nomor_antrian'      => $nomor_antrian,
        ];

        if ($promote_idk) {
            // Promote the reused guest's open WhatsApp visit IN PLACE: re-label with the
            // kiosk-picked service + fresh queue number and flip created_by 'whatsapp' ->
            // 'wa_kiosk' so it leaves the online inbox and joins the physical queue — one
            // visit, nothing dangling (same provenance marker as Kiosk::wa_promote).
            $visit_data['created_by'] = 'wa_kiosk';
            $this->db->where('id_kunjungan', $promote_idk)->update('tamdes_kunjungan', $visit_data);
            $id_kunjungan = $promote_idk;
        } else {
            $visit_data['id_user']    = $id_user;
            $visit_data['created_by'] = 'kiosk';
            $this->db->insert('tamdes_kunjungan', $visit_data);
            $id_kunjungan = $this->db->insert_id();
            if (!$id_kunjungan || $this->db->affected_rows() < 1) {
                // tamdes_kunjungan.id_kunjungan is AUTO_INCREMENT — insert_id()=0 means
                // the INSERT failed (FK constraint, etc.). FE would otherwise navigate
                // to /kiosk/ticket/0 and 404 silently while showing "Pendaftaran berhasil".
                $err = $this->db->error();
                $this->db->query('UNLOCK TABLES');
                log_message('error', 'Kiosk::register tamdes_kunjungan insert failed: ' . print_r($err, true));
                $this->json_response([
                    'success' => false,
                    'message' => 'Gagal membuat kunjungan (database error). Silakan coba lagi atau hubungi petugas.',
                ], 500);
            }
        }

        $this->db->query('UNLOCK TABLES');

        $this->json_response([
            'success'      => true,
            'data'         => ['id_kunjungan' => $id_kunjungan, 'id_user' => $id_user, 'nomor_antrian' => $nomor_antrian],
            'message'      => 'Pendaftaran berhasil',
        ], 201);
    }

    public function visit() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        // Anti-flood on this public no-auth endpoint (same rationale as register).
        // The id_user+layanan/60s dedup below covers double-taps; this caps floods.
        $this->require_rate_limit('kiosk/visit', 30);

        $input   = $this->get_json_input();

        // Strategy C: tolak cross layanan
        $this->validate_no_cross_layanan($input['jenis_layanan'] ?? null);
        $this->validate_sarana_for_layanan($input['jenis_layanan'] ?? null, $input['sarana'] ?? []);

        $id_user = $input['id_user'] ?? null;

        $jenis_layanan_raw = $input['jenis_layanan'] ?? '';
        $jenis_layanan = is_array($jenis_layanan_raw) ? json_encode($jenis_layanan_raw) : $jenis_layanan_raw;

        if (!$id_user || !$jenis_layanan_raw) {
            $this->json_response(['success' => false, 'message' => 'id_user dan jenis_layanan diperlukan'], 400);
        }

        // Dedup: accidental double-tap within 60s for SAME guest + SAME service → return existing.
        // Window is short (60s, not all-day like register) because returning guests legitimately
        // come back same day for different services.
        $recent_cutoff = date('Y-m-d H:i:s', time() - 60);
        $recent = $this->db
            ->where('id_user', $id_user)
            ->where('jenis_layanan', $jenis_layanan)
            ->where('date_visit >=', $recent_cutoff)
            ->order_by('id_kunjungan', 'DESC')
            ->limit(1)
            ->get('tamdes_kunjungan')->row();
        if ($recent) {
            $this->json_response([
                'success' => true,
                'data'    => ['id_kunjungan' => $recent->id_kunjungan, 'nomor_antrian' => $recent->nomor_antrian],
                'message' => 'Kunjungan berhasil dibuat',
            ], 201);
        }

        $nomor_antrian = $this->generate_queue_number(is_array($jenis_layanan_raw) ? ($jenis_layanan_raw[0] ?? '') : $jenis_layanan_raw);

        $sarana_raw = $input['sarana'] ?? [];
        $sarana = is_array($sarana_raw) ? json_encode($sarana_raw) : $sarana_raw;

        $visit_data = [
            'id_user'            => $id_user,
            'jenis_layanan'      => $jenis_layanan,
            'layanan_lainnya'    => $input['layanan_lainnya'] ?? null,
            'sarana'             => $sarana,
            'sarana_lainnya'     => $input['sarana_lainnya'] ?? null,
            'date_visit'         => date('Y-m-d H:i:s'),
            'status'             => 'antri',
            'nomor_antrian'      => $nomor_antrian,
            'created_by'         => 'kiosk',
        ];

        $this->db->insert('tamdes_kunjungan', $visit_data);
        $id_kunjungan = $this->db->insert_id();
        if (!$id_kunjungan || $this->db->affected_rows() < 1) {
            // FK on id_user → tamdes_buku is the realistic failure mode here:
            // FE passed an id_user that doesn't exist (or was just deleted).
            // Returning success with id_kunjungan=0 makes FE 404 on /kiosk/ticket/0.
            $err = $this->db->error();
            log_message('error', 'Kiosk::visit tamdes_kunjungan insert failed (id_user=' . $id_user . '): ' . print_r($err, true));
            $this->json_response([
                'success' => false,
                'message' => 'Gagal membuat kunjungan. ID tamu tidak valid atau database error.',
            ], 500);
        }

        $this->json_response([
            'success' => true,
            'data'    => ['id_kunjungan' => $id_kunjungan, 'nomor_antrian' => $nomor_antrian],
            'message' => 'Kunjungan berhasil dibuat',
        ], 201);
    }

    public function ticket($id) {
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        $ticket = $this->db
            ->select('k.id_kunjungan, k.nomor_antrian, k.jenis_layanan, k.date_visit, b.nama')
            ->from('tamdes_kunjungan k')
            ->join('tamdes_buku b', 'k.id_user = b.id_user', 'left')
            ->where('k.id_kunjungan', $id)
            ->get()->row();

        if (!$ticket) {
            $this->json_response(['success' => false, 'message' => 'Tiket tidak ditemukan'], 404);
        }

        $this->json_response(['success' => true, 'data' => $ticket, 'message' => 'OK']);
    }

    /**
     * GET /api/kiosk/profile-gaps/:id_user
     * Returns list of field names that are NULL/empty for this user.
     */
    public function profile_gaps($id_user) {
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        $user = $this->db->where('id_user', $id_user)->get('tamdes_buku')->row_array();
        if (!$user) {
            $this->json_response(['success' => false, 'message' => 'User tidak ditemukan'], 404);
        }

        // Fields to check — only ones that could be missing from old data
        $checkable = [
            'umur', 'disabilitas', 'jenis_disabilitas',
            'pendidikan', 'pekerjaan', 'kategori_instansi',
            'nama_instansi', 'pemanfaatan', 'email', 'notel',
        ];

        $gaps = [];
        foreach ($checkable as $field) {
            $val = $user[$field] ?? null;
            if ($val === null || $val === '' || $val === '0' || $val === 0) {
                // jenis_disabilitas is only required if disabilitas = 1
                if ($field === 'jenis_disabilitas') {
                    $dis = $user['disabilitas'] ?? null;
                    if ($dis !== null && (int)$dis === 1) {
                        $gaps[] = $field;
                    }
                } else {
                    $gaps[] = $field;
                }
            }
        }

        // Mint a 5-minute continuation token bound to this id_user. The kiosk
        // FE will pass it to profile_update so we know the update is plausibly
        // tied to a recent face-match for this guest, not a drive-by from anyone
        // who guessed an id_user.
        $kiosk_token = $this->mint_kiosk_token('profile-update', (int) $id_user, 300);

        $this->json_response([
            'success' => true,
            'data'    => ['gaps' => $gaps, 'kiosk_token' => $kiosk_token],
            'message' => 'OK',
        ]);
    }

    /**
     * POST /api/kiosk/profile-update/:id_user
     * Patch only provided fields into tamdes_buku.
     * Requires a kiosk-token (purpose=profile-update) bound to this id_user,
     * minted by a recent /api/kiosk/profile-gaps call.
     */
    public function profile_update($id_user) {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        $this->require_kiosk_token('profile-update', (int) $id_user);

        $input = $this->get_json_input();

        $allowed = [
            'umur', 'disabilitas', 'jenis_disabilitas',
            'pendidikan', 'pekerjaan', 'pekerjaan_lainnya',
            'kategori_instansi', 'kategori_lainnya',
            'nama_instansi', 'pemanfaatan', 'pemanfaatan_lainnya',
            'email', 'notel',
        ];

        $update = [];
        foreach ($allowed as $field) {
            if (array_key_exists($field, $input)) {
                $update[$field] = $input[$field];
            }
        }

        // Keep notel canonical if the guest completes their phone here (parity with
        // write-time normalization; update is keyed by id_user so no reuse concern).
        if (array_key_exists('notel', $update)) {
            $update['notel'] = $this->normalize_phone($update['notel']);
        }

        if (empty($update)) {
            $this->json_response(['success' => false, 'message' => 'Tidak ada data untuk diupdate'], 400);
        }

        $this->db->where('id_user', $id_user)->update('tamdes_buku', $update);

        $this->json_response(['success' => true, 'data' => null, 'message' => 'Profil berhasil dilengkapi']);
    }

    /**
     * POST /api/kiosk/wa-lookup { phone }
     * Jalur check-in kiosk untuk pendaftar layanan-online WhatsApp (telepon + wajah).
     * Cari tamu berdasarkan nomor HP + kunjungan WA yang bisa dipromosikan, lalu kembalikan
     * kiosk-token (bound ke id_kunjungan) untuk langkah wa-promote.
     */
    public function wa_lookup() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }
        $this->require_rate_limit('kiosk/wa-lookup', 30);

        $input = $this->get_json_input();
        $phone = $this->normalize_phone((string) ($input['phone'] ?? ''));
        if ($phone === '') {
            $this->json_response(['success' => false, 'message' => 'Nomor HP diperlukan'], 422);
        }

        // Identitas harus tunggal: >1 tamu dengan nomor sama → tak bisa dipastikan siapa
        // (mis. nomor dipakai bersama) → minta bantuan petugas. (mirror multi-match prefill WA)
        $guests = $this->db->select('id_user, nama')->where('notel', $phone)->get('tamdes_buku')->result();
        if (count($guests) === 0) {
            $this->json_response(['success' => false, 'message' => 'Nomor ini tidak terdaftar melalui layanan online WhatsApp. Silakan pilih "Belum Pernah Daftar".'], 404);
        }
        if (count($guests) > 1) {
            $this->json_response(['success' => false, 'message' => 'Nomor terdaftar untuk lebih dari satu pengunjung. Silakan hubungi petugas.'], 409);
        }
        $guest = $guests[0];

        // Kunjungan WA terbaru milik tamu ini yang masih aktif (semua kategori: #1 data online,
        // #2 antrian offline, #3 lainnya). Semua bisa check-in kiosk — #2 mendapat nomor antrian
        // yang sudah ada, #1/#3 diarahkan ke Resepsionis oleh wa-promote.
        $visit = $this->db->select('id_kunjungan, status, nomor_antrian, date_visit')
                          ->where('id_user', $guest->id_user)
                          ->where('created_by', 'whatsapp')
                          ->order_by('id_kunjungan', 'DESC')
                          ->limit(1)
                          ->get('tamdes_kunjungan')->row();
        if (!$visit) {
            $this->json_response(['success' => false, 'message' => 'Nomor ini belum terdaftar via WhatsApp. Silakan pilih "Belum Pernah Daftar".'], 404);
        }
        if (in_array($visit->status, ['selesai', 'evaluasi_selesai'], true)) {
            $this->json_response(['success' => false, 'message' => 'Permintaan Anda sudah selesai kami proses. Silakan daftar baru untuk permintaan lainnya.'], 409);
        }

        // Token bound ke id_kunjungan (TTL 5 menit) — wajib utk wa-promote.
        $kiosk_token = $this->mint_kiosk_token('wa-checkin', (int) $visit->id_kunjungan, 300);

        $this->json_response([
            'success' => true,
            'data'    => ['nama' => $guest->nama, 'id_kunjungan' => (int) $visit->id_kunjungan, 'nomor_antrian' => $visit->nomor_antrian, 'kiosk_token' => $kiosk_token],
            'message' => 'OK',
        ]);
    }

    /**
     * POST /api/kiosk/wa-promote { id_kunjungan, face_descriptor, foto?, biometric_consent,
     *   consent_timestamp }
     * Daftarkan biometrik wajah ke tamu WA (yang sebelumnya tak punya), lalu PROMOSIKAN
     * kunjungan WA-nya jadi kunjungan fisik. Server memutuskan layanan & nomor — TIDAK menerima
     * jenis_layanan/sarana dari kiosk (server-decides pattern, anti-tamper).
     *   #2 (nomor_antrian ada): pertahankan layanan & nomor; regenerasi hanya jika stale-day.
     *   #1/#3 (nomor_antrian null): arahkan ke Resepsionis (jenis=['Lainnya'], nomor=null).
     * Dijaga kiosk-token (purpose wa-checkin) bound ke id_kunjungan.
     */
    public function wa_promote() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }
        $input        = $this->get_json_input();
        $id_kunjungan = (int) ($input['id_kunjungan'] ?? 0);
        if ($id_kunjungan <= 0) {
            $this->json_response(['success' => false, 'message' => 'id_kunjungan diperlukan'], 422);
        }
        $this->require_kiosk_token('wa-checkin', $id_kunjungan);

        // Wajah wajib — inti jalur ini adalah mendaftarkan biometrik.
        if (empty($input['face_descriptor']) || !is_array($input['face_descriptor'])) {
            $this->json_response(['success' => false, 'message' => 'Pemindaian wajah diperlukan'], 422);
        }

        // Kunci + recheck (TOCTOU): kunjungan harus masih WA & belum selesai saat dipromosikan.
        $this->db->query('LOCK TABLES tamdes_buku WRITE, tamdes_kunjungan WRITE');
        $visit = $this->db->select('id_kunjungan, id_user, created_by, status, nomor_antrian, date_visit, jenis_layanan')
                          ->where('id_kunjungan', $id_kunjungan)
                          ->get('tamdes_kunjungan')->row();
        if (!$visit || $visit->created_by !== 'whatsapp') {
            $this->db->query('UNLOCK TABLES');
            $this->json_response(['success' => false, 'message' => 'Kunjungan WhatsApp tidak ditemukan atau sudah diproses.'], 409);
        }
        if (in_array($visit->status, ['selesai', 'evaluasi_selesai'], true)) {
            $this->db->query('UNLOCK TABLES');
            $this->json_response(['success' => false, 'message' => 'Permintaan Anda sudah selesai kami proses.'], 409);
        }
        $id_user = (int) $visit->id_user;

        // 1) Daftarkan wajah + consent ke tamu (tamu WA sebelumnya face_descriptor NULL).
        $foto = null;
        if (!empty($input['foto'])) {
            $b64  = preg_replace('/^data:image\/\w+;base64,/', '', $input['foto']);
            $foto = base64_decode($b64);
        }
        $guest_update = [
            'face_descriptor'   => json_encode($input['face_descriptor']),
            'biometric_consent' => !empty($input['biometric_consent']) ? 1 : 0,
            'consent_timestamp' => !empty($input['consent_timestamp']) ? date('Y-m-d H:i:s', strtotime($input['consent_timestamp'])) : date('Y-m-d H:i:s'),
        ];
        if ($foto !== null) $guest_update['foto'] = $foto;
        $this->db->where('id_user', $id_user)->update('tamdes_buku', $guest_update);

        // 2) Promosikan kunjungan: server memutuskan layanan berdasarkan data WA, bukan input kiosk.
        $today  = date('Y-m-d');
        $hasNum = !empty($visit->nomor_antrian);
        $stale  = $hasNum && (date('Y-m-d', strtotime($visit->date_visit)) !== $today);
        if ($hasNum) {
            // #2 offline: pertahankan layanan & nomor antrian yang sudah ada.
            // Regenerasi nomor hanya bila kunjungan dari hari sebelumnya (reset harian).
            $upd = ['created_by' => 'wa_kiosk', 'status' => 'antri', 'date_visit' => date('Y-m-d H:i:s')];
            if ($stale) {
                $svc = json_decode($visit->jenis_layanan, true);
                $upd['nomor_antrian'] = $this->generate_queue_number(is_array($svc) ? ($svc[0] ?? '') : (string) $svc);
            }
            $this->db->where('id_kunjungan', $id_kunjungan)->update('tamdes_kunjungan', $upd);
            $nomor_antrian = $stale ? $upd['nomor_antrian'] : $visit->nomor_antrian;
            $mode = 'queue';
        } else {
            // #1/#3 fallback: tidak ada nomor antrian — arahkan ke Resepsionis (tanpa nomor TV).
            $this->db->where('id_kunjungan', $id_kunjungan)->update('tamdes_kunjungan', [
                'created_by'    => 'wa_kiosk',
                'status'        => 'antri',
                'jenis_layanan' => json_encode(['Lainnya']),
                'sarana'        => json_encode([1]),
                'nomor_antrian' => null,
                'date_visit'    => date('Y-m-d H:i:s'),
            ]);
            $nomor_antrian = null;
            $mode = 'resepsionis';
        }
        $this->db->query('UNLOCK TABLES');

        $this->json_response([
            'success' => true,
            'data'    => ['id_kunjungan' => $id_kunjungan, 'nomor_antrian' => $nomor_antrian, 'mode' => $mode],
            'message' => 'Check-in berhasil',
        ], 200);
    }

}
