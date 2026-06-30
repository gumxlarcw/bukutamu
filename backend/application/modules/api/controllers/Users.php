<?php
defined('BASEPATH') OR exit('No direct script access allowed');

require_once APPPATH . 'modules/api/controllers/Api_base.php';

class Users extends Api_base {

    public function index() {
        $this->require_auth();
        $this->require_role('superadmin');

        if ($_SERVER['REQUEST_METHOD'] === 'GET') {
            $users = $this->db->select('id, username, nama, role, notel, active, last_login, created_at')
                              ->order_by('id', 'ASC')
                              ->get('admin_users')->result();
            $this->json_response(['success' => true, 'data' => $users, 'message' => 'OK']);

        } elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $input    = $this->get_json_input();
            $username = trim($input['username'] ?? '');
            $password = $input['password'] ?? '';
            $nama     = trim($input['nama'] ?? '');
            $role     = $input['role'] ?? 'operator';

            if (empty($username) || empty($password) || empty($nama)) {
                $this->json_response(['success' => false, 'message' => 'Username, password, dan nama wajib diisi'], 400);
            }
            if (strlen($password) < 8 || !preg_match('/[A-Za-z]/', $password) || !preg_match('/[0-9]/', $password)) {
                $this->json_response(['success' => false, 'message' => 'Password minimal 8 karakter, harus mengandung huruf dan angka'], 400);
            }

            $exists = $this->db->get_where('admin_users', ['username' => $username])->row();
            if ($exists) {
                $this->json_response(['success' => false, 'message' => 'Username sudah digunakan'], 409);
            }

            // Whitelist: tier admin (superadmin/admin/operator) + scope-roles (petugas_pst, resepsionis)
            // + viewer (pimpinan). Default 'operator' jika nilai tidak dikenali.
            // CATATAN PENTING: list ini HARUS sinkron dengan kolom `admin_users.role` (ENUM di MySQL).
            // Kalau tambah role baru di sini tanpa ALTER TABLE, MySQL silently coerce ke '' (empty) di
            // mode non-strict — bug yang sulit dideteksi. Verify-after-insert di bawah ini menangkap drift itu.
            $notel = trim((string) ($input['notel'] ?? ''));

            $valid_roles = ['superadmin', 'admin', 'operator', 'petugas_pst', 'resepsionis', 'pimpinan', 'verifikator'];
            $final_role = in_array($role, $valid_roles, true) ? $role : 'operator';
            $this->db->insert('admin_users', [
                'username'      => $username,
                'password_hash' => password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]),
                'nama'          => $nama,
                'role'          => $final_role,
                'notel'         => ($notel === '' ? null : $notel),
                'active'        => 1,
            ]);
            $new_id = $this->db->insert_id();

            // Defense: verify role aktual yang tersimpan = role yang diniatkan. Kalau beda berarti
            // ENUM column tidak punya value tsb → MySQL coerce ke '' → bug silent. Rollback + error explicit.
            $saved = $this->db->get_where('admin_users', ['id' => $new_id])->row();
            if (!$saved || $saved->role !== $final_role) {
                $actual = $saved ? $saved->role : '(row hilang)';
                $this->db->where('id', $new_id)->delete('admin_users'); // rollback
                $this->json_response([
                    'success' => false,
                    'message' => "Gagal menyimpan role '{$final_role}' — tersimpan sebagai '{$actual}'. "
                              . "Kolom ENUM admin_users.role belum mengizinkan nilai ini. "
                              . "Hubungi admin DB: ALTER TABLE admin_users MODIFY COLUMN role ENUM(...) tambahkan '{$final_role}'.",
                ], 500);
            }

            $this->audit('create', 'admin_user', $new_id, ['username' => $username, 'role' => $final_role]);

            $this->json_response(['success' => true, 'data' => null, 'message' => 'User berhasil dibuat'], 201);
        }
    }

    public function detail($id) {
        $this->require_auth();
        $this->require_role('superadmin');

        if ($_SERVER['REQUEST_METHOD'] === 'PUT') {
            $input  = $this->get_json_input();
            $update = [];

            // Whitelist sama dengan endpoint create (lihat index() di atas).
            // HARUS sinkron dengan ENUM admin_users.role — kalau tidak, MySQL coerce ke ''. Defense di bawah.
            $valid_roles = ['superadmin', 'admin', 'operator', 'petugas_pst', 'resepsionis', 'pimpinan', 'verifikator'];
            $intended_role = null;
            if (isset($input['nama']))   $update['nama']   = trim($input['nama']);
            if (isset($input['role'])) {
                $intended_role = in_array($input['role'], $valid_roles, true) ? $input['role'] : 'operator';
                $update['role'] = $intended_role;
            }
            if (isset($input['notel'])) {
                $notel_val = trim((string) $input['notel']);
                $update['notel'] = ($notel_val === '' ? null : $notel_val);
            }
            if (isset($input['active'])) $update['active']  = $input['active'] ? 1 : 0;

            if (isset($input['password']) && !empty($input['password'])) {
                $pw = $input['password'];
                if (strlen($pw) < 8 || !preg_match('/[A-Za-z]/', $pw) || !preg_match('/[0-9]/', $pw)) {
                    $this->json_response(['success' => false, 'message' => 'Password minimal 8 karakter, harus mengandung huruf dan angka'], 400);
                }
                $update['password_hash'] = password_hash($pw, PASSWORD_BCRYPT, ['cost' => 12]);
            }

            if (empty($update)) {
                $this->json_response(['success' => false, 'message' => 'Tidak ada data untuk diupdate'], 400);
            }

            $this->db->where('id', $id)->update('admin_users', $update);

            // Defense: kalau role di-update, verify nilai yang tersimpan = intended. Kasus ENUM coerce
            // tidak bisa di-rollback otomatis (kita tidak tau old role), jadi return 500 supaya admin tau.
            if ($intended_role !== null) {
                $saved = $this->db->get_where('admin_users', ['id' => $id])->row();
                if (!$saved || $saved->role !== $intended_role) {
                    $actual = $saved ? $saved->role : '(row hilang)';
                    $this->json_response([
                        'success' => false,
                        'message' => "Gagal menyimpan role '{$intended_role}' — tersimpan sebagai '{$actual}'. "
                                  . "Kolom ENUM admin_users.role belum mengizinkan nilai ini. "
                                  . "Jalankan: ALTER TABLE admin_users MODIFY COLUMN role ENUM(...) tambahkan '{$intended_role}'.",
                    ], 500);
                }
            }

            $this->audit('update', 'admin_user', $id, array_diff_key($update, ['password_hash' => '']));

            $this->json_response(['success' => true, 'data' => null, 'message' => 'User berhasil diupdate']);

        } elseif ($_SERVER['REQUEST_METHOD'] === 'DELETE') {
            // Prevent deleting self
            if (isset($this->current_user->id) && (int)$this->current_user->id === (int)$id) {
                $this->json_response(['success' => false, 'message' => 'Tidak bisa menghapus akun sendiri'], 400);
            }
            $this->db->where('id', $id)->delete('admin_users');
            $this->audit('delete', 'admin_user', $id);
            $this->json_response(['success' => true, 'data' => null, 'message' => 'User berhasil dihapus']);
        }
    }

    /** POST /api/users/change-password — change own password */
    public function change_password() {
        $this->require_auth();

        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        $input       = $this->get_json_input();
        $old_pass    = $input['old_password'] ?? '';
        $new_pass    = $input['new_password'] ?? '';
        $username    = $this->current_user->username;

        if (empty($old_pass) || empty($new_pass)) {
            $this->json_response(['success' => false, 'message' => 'Password lama dan baru wajib diisi'], 400);
        }
        if (strlen($new_pass) < 8 || !preg_match('/[A-Za-z]/', $new_pass) || !preg_match('/[0-9]/', $new_pass)) {
            $this->json_response(['success' => false, 'message' => 'Password baru minimal 8 karakter, harus mengandung huruf dan angka'], 400);
        }

        $user = $this->db->get_where('admin_users', ['username' => $username])->row();
        if (!$user || !password_verify($old_pass, $user->password_hash)) {
            $this->json_response(['success' => false, 'message' => 'Password lama salah'], 401);
        }

        $this->db->where('id', $user->id)->update('admin_users', [
            'password_hash' => password_hash($new_pass, PASSWORD_BCRYPT, ['cost' => 12]),
        ]);

        $this->audit('change_password', 'admin_user', $user->id);
        $this->json_response(['success' => true, 'data' => null, 'message' => 'Password berhasil diubah']);
    }
}
