<?php
defined('BASEPATH') OR exit('No direct script access allowed');

class Api_base extends CI_Controller {

    protected $current_user = null;

    public function __construct() {
        parent::__construct();
        $this->load->library('JWT_Helper');

        // CORS headers. Prod serves the SPA same-origin as /api (no CORS needed)
        // or via FRONTEND_URL. The Vite dev server (:5173) reaches /api through
        // its own proxy (vite.config.ts), so it needs no CORS entry either —
        // only allow it when a dev explicitly opts in via CORS_ALLOW_DEV=1.
        $allowed_origins = [];
        $prod_origin = $this->_env('FRONTEND_URL');
        if ($prod_origin) $allowed_origins[] = $prod_origin;
        if ($this->_env('CORS_ALLOW_DEV') === '1') {
            $allowed_origins[] = 'http://localhost:5173';
        }

        $origin = isset($_SERVER['HTTP_ORIGIN']) ? $_SERVER['HTTP_ORIGIN'] : '';
        if (in_array($origin, $allowed_origins)) {
            header('Access-Control-Allow-Origin: ' . $origin);
        }

        header('Content-Type: application/json');
        header('Access-Control-Allow-Credentials: true');
        header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type, Authorization');

        if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
            http_response_code(200);
            exit;
        }
    }

    protected function require_auth() {
        $token = isset($_COOKIE['jwt_token']) ? $_COOKIE['jwt_token'] : null;
        if (!$token) {
            $this->json_response(['success' => false, 'message' => 'Unauthorized'], 401);
            exit;
        }
        $decoded = $this->jwt_helper->decode($token);
        if (!$decoded) {
            $this->json_response(['success' => false, 'message' => 'Invalid token'], 401);
            exit;
        }
        $this->current_user = $decoded;
    }

    protected function json_response($data, $status = 200) {
        http_response_code($status);
        echo json_encode($data);
        exit;
    }

    protected function get_json_input() {
        return json_decode(file_get_contents('php://input'), true) ?? [];
    }

    private static $_dotenv_cache = null;

    protected function _env($key, $default = '') {
        // Try getenv first (works if putenv succeeded)
        $val = getenv($key);
        if ($val !== false && $val !== '') return $val;

        // Try $_SERVER / $_ENV
        if (isset($_SERVER[$key]) && $_SERVER[$key] !== '') return $_SERVER[$key];
        if (isset($_ENV[$key]) && $_ENV[$key] !== '') return $_ENV[$key];

        // Fallback: parse .env file directly
        if (self::$_dotenv_cache === null) {
            self::$_dotenv_cache = [];
            $envFile = FCPATH . '.env';
            if (is_readable($envFile)) {
                $lines = file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
                foreach ($lines as $line) {
                    $line = trim($line);
                    if ($line === '' || $line[0] === '#' || $line[0] === ';') continue;
                    $pos = strpos($line, '=');
                    if ($pos === false) continue;
                    $k = trim(substr($line, 0, $pos));
                    $v = trim(substr($line, $pos + 1));
                    $len = strlen($v);
                    if ($len >= 2) {
                        $f = $v[0]; $l = $v[$len - 1];
                        if (($f === '"' && $l === '"') || ($f === "'" && $l === "'")) {
                            $v = substr($v, 1, -1);
                        }
                    }
                    self::$_dotenv_cache[$k] = $v;
                }
            }
        }

        return isset(self::$_dotenv_cache[$key]) ? self::$_dotenv_cache[$key] : $default;
    }

    protected function require_role($min_role) {
        // resepsionis & petugas_pst share level 1 with legacy operator (different scopes, same tier).
        // pimpinan = viewer tier level 2 (boleh akses page admin read-only seperti audit/eval).
        // Pimpinan TIDAK ada di bypass list require_layanan_role(), jadi tidak bisa finalize visit.
        $role_level = [
            'operator'    => 1,
            'resepsionis' => 1,
            'petugas_pst' => 1,
            'pimpinan'    => 2,
            'admin'       => 2,
            'superadmin'  => 3,
        ];
        $user_role = isset($this->current_user->role) ? $this->current_user->role : 'operator';
        $user_lvl = isset($role_level[$user_role]) ? $role_level[$user_role] : 1;
        $min_lvl = isset($role_level[$min_role]) ? $role_level[$min_role] : 1;
        if ($user_lvl < $min_lvl) {
            $this->json_response(['success' => false, 'message' => 'Akses ditolak. Role tidak mencukupi.'], 403);
        }
    }

    /**
     * Layanan-based authorization. Pastikan role user sesuai dengan jenis layanan visit.
     * - petugas_pst: 4 layanan SKD (Perpustakaan, Konsultasi Statistik, Rekomendasi, Penjualan) + Konsultasi DTSEN
     * - resepsionis: layanan front-office (Lainnya, Keperluan Pimpinan)
     * - admin/superadmin: bypass (full access)
     * - operator (legacy): bypass (untuk backward compat)
     *
     * $jenis_layanan_raw bisa string atau JSON-encoded array dari kolom DB.
     */
    protected function require_layanan_role($jenis_layanan_raw) {
        $role = isset($this->current_user->role) ? $this->current_user->role : 'operator';

        // Bypass roles: full access untuk superadmin, admin, dan operator legacy.
        if (in_array($role, ['admin', 'superadmin', 'operator'], true)) {
            return;
        }

        // Decode jenis_layanan: bisa array, JSON string, atau plain string.
        $list = [];
        if (is_array($jenis_layanan_raw)) {
            $list = $jenis_layanan_raw;
        } elseif (is_string($jenis_layanan_raw) && $jenis_layanan_raw !== '') {
            $decoded = json_decode($jenis_layanan_raw, true);
            $list = is_array($decoded) ? $decoded : [$jenis_layanan_raw];
        }

        // PST role mencakup 4 layanan inti SKD + Konsultasi DTSEN (PST tapi tanpa SKD eval).
        $pst_services = [
            'Perpustakaan',
            'Konsultasi Statistik',
            'Rekomendasi Kegiatan Statistik',
            'Penjualan Produk Statistik',
            'Konsultasi DTSEN',
        ];
        $resepsionis_services = ['Lainnya', 'Keperluan Pimpinan'];

        foreach ($list as $layanan) {
            $is_pst   = in_array($layanan, $pst_services, true);
            $is_resep = in_array($layanan, $resepsionis_services, true);

            if ($is_pst && $role !== 'petugas_pst') {
                $this->json_response([
                    'success' => false,
                    'message' => "Layanan \"{$layanan}\" hanya bisa diselesaikan oleh Petugas PST.",
                ], 403);
            }
            if ($is_resep && $role !== 'resepsionis') {
                $this->json_response([
                    'success' => false,
                    'message' => "Layanan \"{$layanan}\" hanya bisa diselesaikan oleh Resepsionis.",
                ], 403);
            }
        }
    }

    /**
     * Strategy C: tolak kombinasi PST + Resepsionis (cross visit).
     * Tamu harus pilih satu kategori saja. Kalau campur, return 400.
     */
    protected function validate_no_cross_layanan($jenis_layanan_raw) {
        $list = [];
        if (is_array($jenis_layanan_raw)) {
            $list = $jenis_layanan_raw;
        } elseif (is_string($jenis_layanan_raw) && $jenis_layanan_raw !== '') {
            $decoded = json_decode($jenis_layanan_raw, true);
            $list = is_array($decoded) ? $decoded : [$jenis_layanan_raw];
        }
        // 3 grup mutual-exclusive. Cermin frontend src/lib/role-access.ts getServiceGroup().
        $skd_services   = ['Perpustakaan', 'Konsultasi Statistik', 'Rekomendasi Kegiatan Statistik', 'Penjualan Produk Statistik'];
        $dtsen_services = ['Konsultasi DTSEN'];
        $resep_services = ['Lainnya', 'Keperluan Pimpinan'];

        $groups = [];
        foreach ($list as $l) {
            if (in_array($l, $skd_services, true))       $groups['SKD'] = true;
            elseif (in_array($l, $dtsen_services, true)) $groups['DTSEN'] = true;
            elseif (in_array($l, $resep_services, true)) $groups['RESEPSIONIS'] = true;
        }
        if (count($groups) > 1) {
            $this->json_response([
                'success' => false,
                'message' => 'Tidak bisa mencampur kategori layanan. Pilih satu grup saja: SKD inti (Perpustakaan/Konsultasi/Rekomendasi/Penjualan), Konsultasi DTSEN, atau Front-office (Lainnya/Keperluan Pimpinan).',
            ], 400);
        }
    }

    /**
     * Validasi kode sarana harus sesuai grup layanan terpilih.
     * Cermin frontend src/lib/role-access.ts getAllowedSaranaCodes().
     * - SKD: 1, 2, 4, 9, 16, 32 (6 sarana standar BPS)
     * - DTSEN: 1 (PST datang langsung saja)
     * - Resepsionis: 33, 34, 35, 36 (4 ruangan internal)
     */
    protected function validate_sarana_for_layanan($jenis_layanan_raw, $sarana_raw) {
        $layanan_list = [];
        if (is_array($jenis_layanan_raw)) {
            $layanan_list = $jenis_layanan_raw;
        } elseif (is_string($jenis_layanan_raw) && $jenis_layanan_raw !== '') {
            $decoded = json_decode($jenis_layanan_raw, true);
            $layanan_list = is_array($decoded) ? $decoded : [$jenis_layanan_raw];
        }
        $sarana_list = is_array($sarana_raw) ? $sarana_raw : (json_decode((string)$sarana_raw, true) ?: []);
        if (empty($layanan_list) || empty($sarana_list)) return;

        $skd_services   = ['Perpustakaan', 'Konsultasi Statistik', 'Rekomendasi Kegiatan Statistik', 'Penjualan Produk Statistik'];
        $dtsen_services = ['Konsultasi DTSEN'];
        $resep_services = ['Lainnya', 'Keperluan Pimpinan'];

        // Determine grup pertama yang dikenal (asumsi validate_no_cross_layanan sudah dipanggil duluan).
        $group = null;
        foreach ($layanan_list as $l) {
            if (in_array($l, $skd_services, true))       { $group = 'SKD'; break; }
            if (in_array($l, $dtsen_services, true))     { $group = 'DTSEN'; break; }
            if (in_array($l, $resep_services, true))     { $group = 'RESEPSIONIS'; break; }
        }
        if ($group === null) return;

        $allowed = [
            'SKD'         => [1, 2, 4, 9, 16, 32],
            'DTSEN'       => [1],
            'RESEPSIONIS' => [33, 34, 35, 36],
        ][$group];

        foreach ($sarana_list as $code) {
            $code_int = (int)$code;
            if (!in_array($code_int, $allowed, true)) {
                $this->json_response([
                    'success' => false,
                    'message' => "Kode sarana {$code_int} tidak diperbolehkan untuk grup layanan {$group}.",
                ], 400);
            }
        }
    }

    /**
     * Decode jenis_layanan dari kolom DB ke array string nama layanan.
     * Helper internal untuk gate-gate domain di bawah.
     */
    private function decode_layanan_list($jenis_layanan_raw) {
        if (is_array($jenis_layanan_raw)) return $jenis_layanan_raw;
        if (!is_string($jenis_layanan_raw) || $jenis_layanan_raw === '') return [];
        $decoded = json_decode($jenis_layanan_raw, true);
        return is_array($decoded) ? $decoded : [$jenis_layanan_raw];
    }

    /**
     * Apakah visit ini WAJIB punya keterangan (ringkasan non-empty) sebelum bisa selesai?
     * True kalau ada layanan front-office: "Lainnya" atau "Keperluan Pimpinan".
     * Kategori ini tidak punya form evaluasi/konsultasi SKD, jadi keterangan = satu-satunya
     * jejak data tentang apa yang dibantu di kunjungan tsb.
     *
     * Dipakai oleh Visits::status() + Consultations::detail() (gate finalisasi).
     */
    protected function layanan_requires_keterangan($jenis_layanan_raw) {
        $needs = ['Lainnya', 'Keperluan Pimpinan'];
        foreach ($this->decode_layanan_list($jenis_layanan_raw) as $l) {
            if (in_array($l, $needs, true)) return true;
        }
        return false;
    }

    /**
     * Apakah visit ini WAJIB punya form konsultasi PST (≥1 baris kebutuhan_data + hasil_konsultasi)
     * sebelum bisa di-transition ke menunggu_evaluasi/selesai?
     * True untuk 4 layanan inti SKD. DTSEN PST-role tapi punya tabel sendiri.
     */
    protected function layanan_requires_skd_form($jenis_layanan_raw) {
        $skd = ['Perpustakaan', 'Konsultasi Statistik', 'Rekomendasi Kegiatan Statistik', 'Penjualan Produk Statistik'];
        foreach ($this->decode_layanan_list($jenis_layanan_raw) as $l) {
            if (in_array($l, $skd, true)) return true;
        }
        return false;
    }

    /**
     * Apakah visit ini WAJIB punya form DTSEN (1 baris dtsen_konsultasi) sebelum selesai?
     * True jika layanan mengandung "Konsultasi DTSEN".
     */
    protected function layanan_requires_dtsen_form($jenis_layanan_raw) {
        foreach ($this->decode_layanan_list($jenis_layanan_raw) as $l) {
            if ($l === 'Konsultasi DTSEN') return true;
        }
        return false;
    }

    /**
     * Blok II. Kepuasan terhadap Pelayanan Data dan Informasi Statistik BPS.
     * 16 indikator (PermenPAN-RB 14/2017 + SKD BPS). Skala Likert 1-10.
     * Dipindah dari Evaluations.php supaya Visits::detail bisa pakai label yang sama
     * untuk render hasil evaluasi per kunjungan.
     */
    protected function indikator_list() {
        return [
            1  => 'Informasi pelayanan pada unit layanan ini tersedia melalui media elektronik maupun non elektronik.',
            2  => 'Persyaratan pelayanan yang ditetapkan mudah dipenuhi/disiapkan oleh konsumen.',
            3  => 'Prosedur/alur pelayanan yang ditetapkan mudah diikuti/dilakukan.',
            4  => 'Jangka waktu penyelesaian pelayanan yang diterima sesuai dengan yang ditetapkan.',
            5  => 'Biaya pelayanan yang dibayarkan sesuai dengan biaya yang ditetapkan.',
            6  => 'Produk pelayanan yang diterima sesuai dengan yang dijanjikan.',
            7  => 'Sarana dan prasarana pendukung pelayanan memberikan kenyamanan.',
            8  => 'Data BPS mudah diakses melalui sarana utama yang digunakan.',
            9  => 'Petugas pelayanan dan/atau aplikasi pelayanan online merespon dengan baik.',
            10 => 'Petugas pelayanan dan/atau aplikasi pelayanan online mampu memberikan informasi yang jelas.',
            11 => 'Fasilitas pengaduan PST mudah diakses (contoh: Kotak saran dan pengaduan, website https://webapps.bps.go.id/pengaduan, e-mail bpshq@bps.go.id).',
            12 => 'Tidak ada diskriminasi dalam pelayanan.',
            13 => 'Tidak ada pelayanan di luar prosedur/kecurangan pelayanan.',
            14 => 'Tidak ada penerimaan gratifikasi.',
            15 => 'Tidak ada pungutan liar (pungli) dalam pelayanan.',
            16 => 'Tidak ada praktik percaloan dalam pelayanan.',
        ];
    }

    /**
     * Tentukan status finalisasi berdasarkan jenis layanan.
     * - SKD (4 layanan inti: Perpustakaan, Konsultasi, Rekomendasi, Penjualan) → 'menunggu_evaluasi'
     * - Konsultasi DTSEN → 'selesai' langsung (PST role tapi di luar kuesioner SKD)
     * - Resepsionis (Lainnya, Keperluan Pimpinan) → 'selesai' langsung
     * - Multi-layanan: jika ada minimal satu SKD → tetap 'menunggu_evaluasi'
     */
    protected function next_status_after_completion($jenis_layanan_raw) {
        $list = [];
        if (is_array($jenis_layanan_raw)) {
            $list = $jenis_layanan_raw;
        } elseif (is_string($jenis_layanan_raw) && $jenis_layanan_raw !== '') {
            $decoded = json_decode($jenis_layanan_raw, true);
            $list = is_array($decoded) ? $decoded : [$jenis_layanan_raw];
        }
        // Hanya 4 inti SKD yang memicu evaluasi tablet. DTSEN PST-role tapi skip eval.
        $skd_services = [
            'Perpustakaan',
            'Konsultasi Statistik',
            'Rekomendasi Kegiatan Statistik',
            'Penjualan Produk Statistik',
        ];
        foreach ($list as $layanan) {
            if (in_array($layanan, $skd_services, true)) {
                return 'menunggu_evaluasi';
            }
        }
        return 'selesai';
    }

    /**
     * Canonical visit status values — mirrors the `tamdes_kunjungan.status` ENUM
     * and the frontend `VisitStatus` union (src/types/visit.ts). Reject any
     * inbound status from a client PUT that isn't in this set, before the DB
     * write, so MySQL can't silently coerce a bad value to ''.
     */
    protected function valid_statuses() {
        return ['antri', 'dipanggil', 'proses', 'diproses', 'menunggu_evaluasi', 'selesai'];
    }

    /**
     * Mint a short-lived continuation token for unauthenticated kiosk endpoints.
     * Format: {purpose}.{bound_id}.{exp_unix}.{base64url-hmac}
     * HMAC-signed with JWT_SECRET (same secret, different purpose namespace via the
     * `purpose` claim so a profile-update token can't be replayed as eval-submit).
     *
     * Used by:
     *   - Kiosk::profile_gaps mints `profile-update` token (5 min) for profile_update
     *   - Evaluations::pending mints `eval-submit` token (10 min) for /api/evaluations/{id} GET+POST
     */
    protected function mint_kiosk_token($purpose, $bound_id, $ttl_seconds = 300) {
        $exp     = time() + $ttl_seconds;
        $payload = $purpose . '.' . $bound_id . '.' . $exp;
        $secret  = $this->jwt_helper_secret();
        $sig     = rtrim(strtr(base64_encode(hash_hmac('sha256', $payload, $secret, true)), '+/', '-_'), '=');
        return $payload . '.' . $sig;
    }

    /**
     * Verify a kiosk continuation token. Sends 401 + exits on any failure.
     * Token must be sent via X-Kiosk-Token header (or kiosk_token in body for compat).
     */
    protected function require_kiosk_token($expected_purpose, $expected_bound_id) {
        $token = isset($_SERVER['HTTP_X_KIOSK_TOKEN']) ? trim($_SERVER['HTTP_X_KIOSK_TOKEN']) : '';
        if ($token === '') {
            $body  = $this->get_json_input();
            $token = isset($body['kiosk_token']) ? trim((string) $body['kiosk_token']) : '';
        }
        if ($token === '') {
            $this->json_response(['success' => false, 'message' => 'Kiosk token diperlukan'], 401);
        }

        $parts = explode('.', $token);
        if (count($parts) !== 4) {
            $this->json_response(['success' => false, 'message' => 'Kiosk token tidak valid'], 401);
        }
        list($purpose, $bound_id, $exp, $sig) = $parts;

        // Verify signature first to avoid leaking timing info on claim values
        $expected_sig = rtrim(strtr(base64_encode(
            hash_hmac('sha256', "$purpose.$bound_id.$exp", $this->jwt_helper_secret(), true)
        ), '+/', '-_'), '=');
        if (!hash_equals($expected_sig, $sig)) {
            $this->json_response(['success' => false, 'message' => 'Kiosk token tidak valid'], 401);
        }

        if ((int) $exp < time()) {
            $this->json_response(['success' => false, 'message' => 'Kiosk token kadaluarsa'], 401);
        }
        if ($purpose !== $expected_purpose) {
            $this->json_response(['success' => false, 'message' => 'Kiosk token tidak sesuai endpoint'], 403);
        }
        if ((string) $bound_id !== (string) $expected_bound_id) {
            $this->json_response(['success' => false, 'message' => 'Kiosk token tidak cocok dengan resource'], 403);
        }
    }

    /**
     * Read JWT_Helper's secret via reflection so kiosk-token helpers stay in sync
     * with whatever JWT_Helper resolves (env → .env file → fallback hash).
     */
    private function jwt_helper_secret() {
        $ref  = new ReflectionClass($this->jwt_helper);
        $prop = $ref->getProperty('secret');
        $prop->setAccessible(true);
        return $prop->getValue($this->jwt_helper);
    }

    /**
     * Soft rate limit for unauthenticated endpoints. Counts hits per (IP, endpoint)
     * in the last 60 seconds; if over $max_per_minute, returns 429 + exits.
     *
     * Used by kiosk endpoints that return data sets we don't want scraped at high
     * speed (face descriptors, guest lists). Not a security perimeter — a
     * determined scraper can still extract everything slowly. To fully prevent
     * enumeration, restrict source IPs at Apache (`Require ip 10.x.x.x` etc.).
     *
     * Storage: tamdes_rate_limit. Inline pruning (rows older than 5 min for this
     * IP) keeps the table bounded without a separate cron.
     */
    protected function require_rate_limit($endpoint, $max_per_minute = 30) {
        $ip = $this->input->ip_address();

        // Prune stale rows for this IP (keep last 5 min only) — cheap thanks to
        // the (ip_address, created_at) index.
        $this->db->where('ip_address', $ip)
                 ->where('created_at <', date('Y-m-d H:i:s', time() - 300))
                 ->delete('tamdes_rate_limit');

        // Count hits in the last minute for this (ip, endpoint).
        $recent = $this->db
            ->where('ip_address', $ip)
            ->where('endpoint', $endpoint)
            ->where('created_at >=', date('Y-m-d H:i:s', time() - 60))
            ->count_all_results('tamdes_rate_limit');

        if ($recent >= $max_per_minute) {
            header('Retry-After: 60');
            $this->json_response([
                'success' => false,
                'message' => "Terlalu banyak permintaan. Coba lagi setelah 60 detik.",
            ], 429);
        }

        $this->db->insert('tamdes_rate_limit', [
            'ip_address' => $ip,
            'endpoint'   => $endpoint,
        ]);
    }

    protected function audit($action, $target_type, $target_id = null, $detail = null) {
        $user = $this->current_user->username ?? 'system';
        $this->db->insert('tamdes_audit_log', [
            'admin_user'  => $user,
            'action'      => $action,
            'target_type' => $target_type,
            'target_id'   => $target_id,
            'detail'      => $detail ? json_encode($detail) : null,
            'ip_address'  => $this->input->ip_address(),
        ]);
    }

    /**
     * Compare old row (assoc array) with new data, return only changed fields.
     * Format: { field: { from: old_val, to: new_val } }
     */
    protected function diff_changes($old, $new) {
        $changes = [];
        foreach ($new as $key => $new_val) {
            $old_val = isset($old[$key]) ? $old[$key] : null;
            // Normalize for comparison
            if (is_numeric($old_val) && is_numeric($new_val)) {
                if ((float)$old_val === (float)$new_val) continue;
            } elseif ((string)$old_val === (string)$new_val) {
                continue;
            }
            $changes[$key] = ['from' => $old_val, 'to' => $new_val];
        }
        return $changes;
    }

    protected function generate_queue_number($jenis_layanan) {
        if (in_array(strtolower($jenis_layanan), ['lainnya', 'keperluan pimpinan'])) {
            return null;
        }

        // Override prefix khusus: DTSEN → "D" (membedakan dari "K" Konsultasi Statistik di TV)
        $prefix = strtolower($jenis_layanan) === 'konsultasi dtsen'
            ? 'D'
            : strtoupper(substr($jenis_layanan, 0, 1));
        $today  = date('Y-m-d');

        $count = $this->db->where('DATE(date_visit)', $today)
                          ->where('jenis_layanan', $jenis_layanan)
                          ->count_all_results('tamdes_kunjungan');

        $number = $count + 1;

        return $prefix . str_pad($number, 3, '0', STR_PAD_LEFT);
    }

    /**
     * Read a value from the git-ignored config/push.php (VAPID public key,
     * internal secret). Returns null if the file/key is absent (push not set up),
     * so callers can degrade gracefully instead of fataling.
     */
    protected function push_config($key) {
        $this->config->load('push', FALSE, TRUE); // 3rd arg = fail gracefully
        $val = $this->config->item($key);
        return ($val === FALSE) ? null : $val;
    }

    /**
     * Guard internal-only endpoints (push dispatch/prune) consumed by the notifier
     * service. Validates the X-Internal-Secret header against config/push.php and
     * restricts to loopback callers. 403/503 + exit on failure.
     */
    protected function require_internal_secret() {
        $secret = $this->push_config('push_internal_secret');
        if (!$secret) {
            $this->json_response(['success' => false, 'message' => 'Push not configured'], 503);
        }
        $remote = $_SERVER['REMOTE_ADDR'] ?? '';
        if (!in_array($remote, ['127.0.0.1', '::1', 'localhost'], true)) {
            $this->json_response(['success' => false, 'message' => 'Forbidden'], 403);
        }
        $given = isset($_SERVER['HTTP_X_INTERNAL_SECRET']) ? trim($_SERVER['HTTP_X_INTERNAL_SECRET']) : '';
        if ($given === '' || !hash_equals((string) $secret, $given)) {
            $this->json_response(['success' => false, 'message' => 'Forbidden'], 403);
        }
    }
}
