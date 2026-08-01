<?php
defined('BASEPATH') OR exit('No direct script access allowed');

require_once APPPATH . 'modules/api/controllers/Api_base.php';

class Auth extends Api_base {

    private $max_attempts = 5;
    private $lockout_minutes = 15;

    public function check() {
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }
        $this->require_auth();

        // Return user info from DB if available, otherwise from JWT
        $user_data = [
            'id'       => $this->current_user->id ?? 0,
            'username' => $this->current_user->username,
            'nama'     => $this->current_user->nama ?? $this->current_user->username,
        ];

        // Try to get fresh data from admin_users table
        $db_user = $this->db->get_where('admin_users', ['username' => $this->current_user->username])->row();
        if ($db_user) {
            $user_data['id']   = $db_user->id;
            $user_data['nama'] = $db_user->nama;
            $user_data['role'] = $db_user->role;
        }

        $this->json_response([
            'success' => true,
            'data'    => $user_data,
            'message' => 'Authenticated',
        ]);
    }

    public function login() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        $input    = $this->get_json_input();
        $username = isset($input['username']) ? trim($input['username']) : '';
        $password = isset($input['password']) ? $input['password'] : '';
        $ip       = $this->input->ip_address();

        if (empty($username) || empty($password)) {
            $this->json_response(['success' => false, 'message' => 'Username dan password wajib diisi'], 400);
        }

        // ── Rate limiting: failed attempts for this (IP, username) pair ──
        // Kunci WAJIB menyertakan username. Tanpa itu hitungannya per-IP saja, dan
        // karena backend ada di balik Cloudflare Tunnel (cloudflared -> localhost:60,
        // mod_remoteip belum aktif) SEMUA klien internet tercatat '::1' — satu ember
        // bersama. Akibatnya 5 request gagal dari mana pun mengunci KEDELAPAN akun
        // admin sekaligus. Lihat docs/AUDIT_2026-08-01.md temuan #2.
        // Setelah mod_remoteip aktif (Batch 3), kunci ini otomatis jadi benar-benar
        // per-(IP, username): penyerang dari satu IP tidak lagi mengunci admin sah
        // yang login dari IP lain.
        $cutoff = date('Y-m-d H:i:s', time() - ($this->lockout_minutes * 60));
        $recent_fails = $this->db
            ->where('ip_address', $ip)
            ->where('username', $username)
            ->where('success', 0)
            ->where('created_at >', $cutoff)
            ->count_all_results('tamdes_login_attempts');

        if ($recent_fails >= $this->max_attempts) {
            // JANGAN catat kegagalan lagi di sini. Baris ini dulu menulis success=0
            // pada jalur yang SUDAH ditolak, sehingga tiap percobaan ulang petugas
            // menggeser jendela 15 menit maju — korban mengunci dirinya sendiri
            // tanpa henti. Lima kegagalan sebelumnya sudah tercatat; cukup.
            log_message('error', "login lockout aktif: user={$username} ip={$ip}");
            $this->json_response([
                'success' => false,
                'message' => "Terlalu banyak percobaan login. Coba lagi dalam {$this->lockout_minutes} menit.",
            ], 429);
        }

        // ── Authenticate: try admin_users table first, then .env fallback ──
        $user = $this->db->get_where('admin_users', [
            'username' => $username,
            'active'   => 1,
        ])->row();

        $authenticated = false;
        $user_data     = null;

        if ($user && password_verify($password, $user->password_hash)) {
            $authenticated = true;
            $user_data = [
                'id'       => $user->id,
                'username' => $user->username,
                'nama'     => $user->nama,
                'role'     => $user->role,
            ];
            // Update last_login
            $this->db->where('id', $user->id)->update('admin_users', ['last_login' => date('Y-m-d H:i:s')]);
        } else {
            // Fallback: .env credentials (for backward compatibility)
            $envVars        = $this->_load_env_file();
            $valid_username = isset($envVars['ADMIN_USERNAME']) ? $envVars['ADMIN_USERNAME'] : '';
            $password_hash  = isset($envVars['ADMIN_PASSWORD_HASH']) ? $envVars['ADMIN_PASSWORD_HASH'] : '';

            if ($valid_username && $username === $valid_username && password_verify($password, $password_hash)) {
                $authenticated = true;
                $user_data = [
                    'id'       => 0,
                    'username' => $username,
                    'nama'     => $username,
                    'role'     => 'superadmin',
                ];
            }
        }

        // ── Log attempt ──
        $this->_log_attempt($ip, $username, $authenticated ? 1 : 0);

        if (!$authenticated) {
            $remaining = $this->max_attempts - $recent_fails - 1;
            $msg = 'Username atau password salah';
            if ($remaining <= 2 && $remaining > 0) {
                $msg .= ". Sisa {$remaining} percobaan sebelum akun dikunci.";
            }
            $this->json_response(['success' => false, 'message' => $msg], 401);
        }

        // ── Issue JWT ──
        $token = $this->jwt_helper->encode($user_data);

        setcookie('jwt_token', $token, [
            'expires'  => time() + 14400, // 4 hours
            'path'     => '/',
            'httponly'  => true,
            'samesite' => 'Strict',
            // TLS diterminasi di Cloudflare; Apache menerima plain HTTP dan tidak ada
            // yang menyetel HTTPS=on, jadi ekspresi lama SELALU false — cookie admin
            // 4 jam terbit TANPA Secure. Ambil dari config yang sama yang sudah dipakai
            // CI3 untuk ci_session (diturunkan dari base_url https, bernilai true).
            // JANGAN turunkan dari X-Forwarded-Proto: header yang bisa dipengaruhi klien
            // tidak boleh menentukan flag keamanan cookie. Aman dipasang hanya SETELAH
            // redirect http->https ada di vhost :60, kalau tidak sesi admin yang membuka
            // lewat http akan diam-diam gagal tersimpan. AUDIT_2026-08-01 #7.
            'secure'   => (bool) $this->config->item('cookie_secure'),
        ]);

        // Audit log
        $this->db->insert('tamdes_audit_log', [
            'admin_user'  => $username,
            'action'      => 'login',
            'target_type' => 'auth',
            'ip_address'  => $ip,
        ]);

        $this->json_response([
            'success' => true,
            'data'    => $user_data,
            'message' => 'Login berhasil',
        ]);
    }

    public function logout() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        // Audit log — HANYA bila pemiliknya bisa diidentifikasi.
        //
        // Sengaja TIDAK memakai require_auth(): logout dengan token yang sudah
        // kedaluwarsa itu sah, dan 401 di sini akan meninggalkan cookie basi di
        // browser petugas. Yang salah bukan itu, melainkan mencatat baris audit
        // untuk POST yang sama sekali tanpa identitas: 66 dari 120 baris logout
        // tercatat 'unknown', yang membuat jejak logout tak bisa dipakai dan
        // memberi siapa pun cara menulis ke audit log tanpa autentikasi.
        // Tanpa identitas → tidak ada yang perlu diaudit; cookie tetap dibersihkan.
        // AUDIT_2026-08-01 #24j.
        $username = null;
        $token = isset($_COOKIE['jwt_token']) ? $_COOKIE['jwt_token'] : null;
        if ($token) {
            $decoded = $this->jwt_helper->decode($token);
            if ($decoded && !empty($decoded->username)) $username = $decoded->username;
        }
        if ($username === null && !empty($this->current_user->username)) {
            $username = $this->current_user->username;
        }

        if ($username !== null) {
            $this->db->insert('tamdes_audit_log', [
                'admin_user'  => $username,
                'action'      => 'logout',
                'target_type' => 'auth',
                'ip_address'  => $this->input->ip_address(),
            ]);
        }

        setcookie('jwt_token', '', [
            'expires'  => time() - 3600,
            'path'     => '/',
            'httponly'  => true,
            'samesite' => 'Strict',
            // TLS diterminasi di Cloudflare; Apache menerima plain HTTP dan tidak ada
            // yang menyetel HTTPS=on, jadi ekspresi lama SELALU false — cookie admin
            // 4 jam terbit TANPA Secure. Ambil dari config yang sama yang sudah dipakai
            // CI3 untuk ci_session (diturunkan dari base_url https, bernilai true).
            // JANGAN turunkan dari X-Forwarded-Proto: header yang bisa dipengaruhi klien
            // tidak boleh menentukan flag keamanan cookie. Aman dipasang hanya SETELAH
            // redirect http->https ada di vhost :60, kalau tidak sesi admin yang membuka
            // lewat http akan diam-diam gagal tersimpan. AUDIT_2026-08-01 #7.
            'secure'   => (bool) $this->config->item('cookie_secure'),
        ]);

        $this->json_response(['success' => true, 'data' => null, 'message' => 'Logout berhasil']);
    }

    private function _log_attempt($ip, $username, $success) {
        $this->db->insert('tamdes_login_attempts', [
            'ip_address' => $ip,
            'username'   => $username,
            'success'    => $success,
        ]);
    }

    private function _load_env_file() {
        $result  = [];
        $envFile = FCPATH . '.env';
        if (!is_readable($envFile)) return $result;
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
            $result[$k] = $v;
        }
        return $result;
    }
}
