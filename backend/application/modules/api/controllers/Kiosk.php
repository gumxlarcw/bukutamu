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

        // Prevent double-submit: check if same nama+notel registered in last 30 seconds
        $recent = $this->db->where('nama', $input['nama'] ?? '')
                           ->where('notel', $input['notel'] ?? '')
                           ->where('tgldatang', date('Y-m-d'))
                           ->order_by('id_user', 'DESC')
                           ->get('tamdes_buku')->row();
        if ($recent) {
            // Already registered today — return existing visit
            $existing_visit = $this->db->where('id_user', $recent->id_user)
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

        // Generate id_user with table lock to prevent race condition
        $this->db->query('LOCK TABLES tamdes_buku WRITE, tamdes_kunjungan WRITE, tamdes_responden_tahunan WRITE');
        $max    = $this->db->select_max('id_user')->get('tamdes_buku')->row()->id_user;
        $new_id = $max ? $max + 1 : 8200001;

        // Handle photo: base64 decode if provided
        $foto = null;
        if (!empty($input['foto'])) {
            // Strip data URI prefix if present
            $b64 = preg_replace('/^data:image\/\w+;base64,/', '', $input['foto']);
            $foto = base64_decode($b64);
        }

        $guest_data = [
            'id_user'              => $new_id,
            'nama'                 => $input['nama'] ?? '',
            'email'                => $input['email'] ?? '',
            'notel'                => $input['notel'] ?? '',
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

        // Insert visit — jenis_layanan & sarana stored as JSON arrays
        $jenis_layanan_raw = $input['jenis_layanan'] ?? '';
        $jenis_layanan = is_array($jenis_layanan_raw) ? json_encode($jenis_layanan_raw) : $jenis_layanan_raw;
        $nomor_antrian = $this->generate_queue_number(is_array($jenis_layanan_raw) ? ($jenis_layanan_raw[0] ?? '') : $jenis_layanan_raw);

        $sarana_raw = $input['sarana'] ?? [];
        $sarana = is_array($sarana_raw) ? json_encode($sarana_raw) : $sarana_raw;

        $visit_data = [
            'id_user'            => $new_id,
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

        $this->db->query('UNLOCK TABLES');

        $this->json_response([
            'success'      => true,
            'data'         => ['id_kunjungan' => $id_kunjungan, 'id_user' => $new_id, 'nomor_antrian' => $nomor_antrian],
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

        // Kunjungan WA terbaru milik tamu ini yang masih bisa dilayani fisik. HANYA pra-daftar
        // "Daftar Antrian Offline" (kategori #2) yang boleh check-in kiosk — permintaan data online
        // (#1) & "Lainnya Online" (#3) diproses lewat WhatsApp, bukan antrian fisik.
        $visit = $this->db->select('id_kunjungan, status')
                          ->where('id_user', $guest->id_user)
                          ->where('created_by', 'whatsapp')
                          ->like('jenis_layanan', 'Daftar Antrian Offline')
                          ->order_by('id_kunjungan', 'DESC')
                          ->limit(1)
                          ->get('tamdes_kunjungan')->row();
        if (!$visit) {
            $this->json_response(['success' => false, 'message' => 'Tidak ada pendaftaran antrian offline untuk nomor ini. Permintaan data online diproses & dibalas lewat WhatsApp.'], 404);
        }
        if (in_array($visit->status, ['selesai', 'evaluasi_selesai'], true)) {
            $this->json_response(['success' => false, 'message' => 'Permintaan Anda sudah selesai kami proses. Silakan daftar baru untuk permintaan lainnya.'], 409);
        }

        // Token bound ke id_kunjungan (TTL 5 menit) — wajib utk wa-promote.
        $kiosk_token = $this->mint_kiosk_token('wa-checkin', (int) $visit->id_kunjungan, 300);

        $this->json_response([
            'success' => true,
            'data'    => ['nama' => $guest->nama, 'id_kunjungan' => (int) $visit->id_kunjungan, 'kiosk_token' => $kiosk_token],
            'message' => 'OK',
        ]);
    }

    /**
     * POST /api/kiosk/wa-promote { id_kunjungan, face_descriptor, foto?, biometric_consent,
     *   consent_timestamp, jenis_layanan, layanan_lainnya, sarana, sarana_lainnya }
     * Daftarkan biometrik wajah ke tamu WA (yang sebelumnya tak punya), lalu PROMOSIKAN
     * kunjungan WA-nya jadi kunjungan fisik: layanan pilihan kiosk + nomor antrian fisik +
     * created_by='wa_kiosk' (keluar dari inbox Layanan Online, masuk antrean PST; provenance tetap).
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

        // Taksonomi layanan — sama seperti register/visit (sebelum LOCK; bisa sentuh tabel lain).
        $this->validate_no_cross_layanan($input['jenis_layanan'] ?? null);
        $this->validate_sarana_for_layanan($input['jenis_layanan'] ?? null, $input['sarana'] ?? []);

        // Wajah wajib — inti jalur ini adalah mendaftarkan biometrik.
        if (empty($input['face_descriptor']) || !is_array($input['face_descriptor'])) {
            $this->json_response(['success' => false, 'message' => 'Pemindaian wajah diperlukan'], 422);
        }

        // Kunci + recheck (TOCTOU): kunjungan harus masih WA & belum selesai saat dipromosikan.
        $this->db->query('LOCK TABLES tamdes_buku WRITE, tamdes_kunjungan WRITE');
        $visit = $this->db->select('id_kunjungan, id_user, created_by, status')
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

        // 2) Promosikan kunjungan: layanan pilihan kiosk + nomor antrian fisik + created_by='wa_kiosk'.
        $jl_raw = $input['jenis_layanan'] ?? '';
        $jl     = is_array($jl_raw) ? json_encode($jl_raw) : $jl_raw;
        $sr_raw = $input['sarana'] ?? [];
        $sr     = is_array($sr_raw) ? json_encode($sr_raw) : $sr_raw;
        $nomor_antrian = $this->generate_queue_number(is_array($jl_raw) ? ($jl_raw[0] ?? '') : $jl_raw);

        $this->db->where('id_kunjungan', $id_kunjungan)->update('tamdes_kunjungan', [
            'jenis_layanan'   => $jl,
            'layanan_lainnya' => $input['layanan_lainnya'] ?? null,
            'sarana'          => $sr,
            'sarana_lainnya'  => $input['sarana_lainnya'] ?? null,
            'nomor_antrian'   => $nomor_antrian,
            'status'          => 'antri',
            'date_visit'      => date('Y-m-d H:i:s'),
            'created_by'      => 'wa_kiosk',
        ]);
        $this->db->query('UNLOCK TABLES');

        $this->json_response([
            'success' => true,
            'data'    => ['id_kunjungan' => $id_kunjungan, 'nomor_antrian' => $nomor_antrian],
            'message' => 'Check-in berhasil',
        ], 200);
    }

}
