<?php
defined('BASEPATH') OR exit('No direct script access allowed');

require_once APPPATH . 'modules/api/controllers/Api_base.php';

class Guests extends Api_base {

    // Columns safe for JSON (excludes foto longblob)
    private $safe_columns = 'id_user, tgldatang, nama, email, notel, jeniskelamin, umur, disabilitas, jenis_disabilitas, pendidikan, pekerjaan, pekerjaan_lainnya, kategori_instansi, kategori_lainnya, nama_instansi, pemanfaatan, pemanfaatan_lainnya, pengaduan, registered_via';

    public function index() {
        if ($_SERVER['REQUEST_METHOD'] === 'GET') {
            $this->require_auth();

            $search = $this->input->get('search');
            $page = max(1, (int) ($this->input->get('page') ?: 1));
            $limit = max(1, (int) ($this->input->get('limit') ?: 10));
            $offset = ($page - 1) * $limit;

            if ($search) {
                $this->db->group_start()
                         ->like('nama', $search)
                         ->or_like('email', $search)
                         ->or_like('nama_instansi', $search)
                         ->or_like('notel', $search)
                         ->group_end();
            }
            $total = $this->db->count_all_results('tamdes_buku');

            $this->db->select($this->safe_columns);
            if ($search) {
                $this->db->group_start()
                         ->like('nama', $search)
                         ->or_like('email', $search)
                         ->or_like('nama_instansi', $search)
                         ->or_like('notel', $search)
                         ->group_end();
            }
            $guests = $this->db->order_by('id_user', 'DESC')
                               ->limit($limit, $offset)
                               ->get('tamdes_buku')
                               ->result();

            $this->json_response([
                'success' => true,
                'data' => $guests,
                'message' => 'OK',
                'pagination' => [
                    'page' => $page,
                    'limit' => $limit,
                    'total' => (int) $total,
                    'totalPages' => max(1, (int) ceil($total / $limit)),
                ],
            ]);

        } elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $this->require_auth();
            $input = $this->get_json_input();

            // Race-safety: same pattern as Kiosk::register. MAX(id_user)+1 is not
            // atomic under concurrent writes; lock briefly while we compute & insert.
            $this->db->query('LOCK TABLES tamdes_buku WRITE');
            $max = $this->db->select_max('id_user')->get('tamdes_buku')->row()->id_user;
            $new_id = $max ? $max + 1 : 8200001;

            $data = [
                'id_user' => $new_id,
                'nama' => $input['nama'] ?? '',
                'email' => $input['email'] ?? '',
                'notel' => $input['notel'] ?? '',
                'jeniskelamin' => $input['jeniskelamin'] ?? '',
                'pendidikan' => $input['pendidikan'] ?? '',
                'pekerjaan' => $input['pekerjaan'] ?? '',
                'kategori_instansi' => $input['kategori_instansi'] ?? '',
                'nama_instansi' => $input['nama_instansi'] ?? '',
                'pemanfaatan' => $input['pemanfaatan'] ?? '',
                'pengaduan' => $input['pengaduan'] ?? '',
                'tgldatang' => date('Y-m-d'),
                'registered_via' => 'admin:' . ($this->current_user->username ?? 'unknown'),
                'face_descriptor' => isset($input['face_descriptor']) ? json_encode($input['face_descriptor']) : null,
            ];
            $this->db->insert('tamdes_buku', $data);
            $this->db->query('UNLOCK TABLES');
            $guest = $this->db->select($this->safe_columns)
                              ->get_where('tamdes_buku', ['id_user' => $new_id])
                              ->row();
            $this->json_response(['success' => true, 'data' => $guest, 'message' => 'Tamu berhasil ditambahkan'], 201);
        }
    }

    public function detail($id) {
        $this->require_auth();

        if ($_SERVER['REQUEST_METHOD'] === 'GET') {
            $guest = $this->db->select($this->safe_columns)
                              ->get_where('tamdes_buku', ['id_user' => $id])
                              ->row();
            if (!$guest) {
                $this->json_response(['success' => false, 'message' => 'Tamu tidak ditemukan'], 404);
            }
            $this->json_response(['success' => true, 'data' => $guest, 'message' => 'OK']);

        } elseif ($_SERVER['REQUEST_METHOD'] === 'PUT') {
            $input = $this->get_json_input();
            $allowed = ['nama', 'email', 'notel', 'jeniskelamin', 'umur',
                        'disabilitas', 'jenis_disabilitas', 'pendidikan',
                        'pekerjaan', 'pekerjaan_lainnya', 'kategori_instansi',
                        'kategori_lainnya', 'nama_instansi', 'pemanfaatan',
                        'pemanfaatan_lainnya', 'pengaduan'];
            $data = array_intersect_key($input, array_flip($allowed));
            if (empty($data)) {
                $this->json_response(['success' => false, 'message' => 'Tidak ada field valid untuk diupdate'], 400);
            }
            // Get old data for diff
            $old = $this->db->get_where('tamdes_buku', ['id_user' => $id])->row_array();
            $this->db->where('id_user', $id)->update('tamdes_buku', $data);
            $changes = $this->diff_changes($old ?: [], $data);
            if (!empty($changes)) {
                $this->audit('update', 'guest', $id, $changes);
            }
            $guest = $this->db->select($this->safe_columns)
                              ->get_where('tamdes_buku', ['id_user' => $id])
                              ->row();
            $this->json_response(['success' => true, 'data' => $guest, 'message' => 'Tamu berhasil diupdate']);

        } elseif ($_SERVER['REQUEST_METHOD'] === 'DELETE') {
            $this->require_role('admin');

            // Refuse if guest has visits — admin must delete each visit first (which
            // cascades to consultations/dtsen/evaluations per Visits::detail DELETE).
            // Auto-cascading here would silently nuke years of evaluation history.
            $visit_count = (int) $this->db->where('id_user', $id)->count_all_results('tamdes_kunjungan');
            if ($visit_count > 0) {
                $this->json_response([
                    'success' => false,
                    'message' => "Tidak bisa menghapus tamu yang masih punya {$visit_count} kunjungan. Hapus semua kunjungannya dulu, baru tamunya.",
                ], 409);
            }

            $this->audit('delete', 'guest', $id);
            $this->db->where('id_user', $id)->delete('tamdes_buku');
            $this->json_response(['success' => true, 'data' => null, 'message' => 'Tamu berhasil dihapus']);
        }
    }

    /** GET /api/guests/:id/visits — visit history for a guest */
    public function visits($id) {
        $this->require_auth();
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }
        $visits = $this->db->select('id_kunjungan, jenis_layanan, date_visit, status, nomor_antrian, rating_pengunjung')
                           ->where('id_user', $id)
                           ->order_by('date_visit', 'DESC')
                           ->get('tamdes_kunjungan')->result();
        $this->json_response(['success' => true, 'data' => $visits, 'message' => 'OK']);
    }

    /** GET /api/guests/:id/photo — serve photo as image */
    public function photo($id) {
        $this->require_auth();
        $row = $this->db->select('foto')->get_where('tamdes_buku', ['id_user' => $id])->row();
        if (!$row || !$row->foto) {
            http_response_code(404);
            exit;
        }
        header('Content-Type: image/jpeg');
        header('Cache-Control: public, max-age=3600');
        echo $row->foto;
        exit;
    }
}
