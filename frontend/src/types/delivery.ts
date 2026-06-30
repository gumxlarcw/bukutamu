export type DeliveryStatus = 'menunggu_verifikasi' | 'revisi' | 'disetujui' | 'terkirim' | 'dibatalkan'
export type VerifDecision = 'setuju' | 'revisi' | 'setuju_catatan'

export interface DataDelivery {
  id: number
  id_kunjungan: number
  id_konsultasi: number | null
  channel: 'online' | 'offline'
  link_url: string | null
  media_path: string | null
  media_mime: string | null
  media_name: string | null
  note_operator: string | null
  status: DeliveryStatus
  verif_decision: VerifDecision | null
  verif_note: string | null
  short_code: string | null
  created_at: string
}

// Joined verifier-card shape (GET /api/deliveries/:id)
export interface DataDeliveryDetail extends DataDelivery {
  nomor_antrian: string | null
  pemohon_nama: string | null
  instansi: string | null
  pemohon_notel: string | null
  rincian_data: string | null
  wilayah_data: string | null
  tahun_awal: number | null
  tahun_akhir: number | null
  status_data: number | null
}
