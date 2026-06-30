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

    // Oldest pending first — used by the verifier queue AND the WA FIFO mapping.
    public function list_filtered(array $f, int $page, int $limit): array
    {
        $this->db->from('data_deliveries d');
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
}
