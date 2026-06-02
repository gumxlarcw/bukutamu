import type { GuestFormData } from '@/types/guest'

export interface WaPermintaanRow {
  rincian_data: string
  wilayah_data: string
  level_data: number | null
  periode_data: number | null
  tahun_awal: number | null
  tahun_akhir: number | null
}

export interface WaGuestMatch {
  id_user: number
  nama: string
  // email + notel are intentionally NOT returned by the prefill endpoint (PII):
  // the backend echoes only low-sensitivity demographic fields based on phone match.
  email?: string
  notel?: string
  jeniskelamin: string
  umur: number | null
  pendidikan: number | null
  pekerjaan: number | null
  kategori_instansi: number | null
  nama_instansi: string
  pemanfaatan: number | null
}

export interface WaSessionPrefill {
  session_id: number
  phone: string
  state: 'awaiting_form' | 'submitted' | 'expired'
  guest: WaGuestMatch | null
  multi_match: boolean
}

export interface WaIntakePayload extends Partial<GuestFormData> {
  permintaan: WaPermintaanRow[]
}

export interface WaInboxRow {
  id_kunjungan: number
  status: string
  date_visit: string
  selesai_timestamp: string | null
  nama: string
  nama_instansi: string
  notel: string
  has_konsultasi: number
  permintaan: string | null
}
