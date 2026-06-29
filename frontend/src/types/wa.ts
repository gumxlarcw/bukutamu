import type { GuestFormData } from '@/types/guest'

export const JAM_LAYANAN = 'Senin–Kamis 08.00–15.30 WIT, Jumat 08.00–16.00 WIT'

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

export type WaCategory = 'data' | 'offline' | 'lainnya'

export interface WaSessionPrefill {
  session_id: number
  phone: string
  state: 'awaiting_category' | 'awaiting_form' | 'submitted' | 'expired'
  category?: WaCategory   // 'data' (full form) | 'offline' (Data Diri only) — backend defaults to 'data'
  guest: WaGuestMatch | null
  multi_match: boolean
}

export interface WaIntakePayload extends Partial<GuestFormData> {
  permintaan: WaPermintaanRow[]
  update_profile?: boolean   // true = "Perbarui Profil" (timpa); false = pakai data DB apa adanya
  // Offline mode — service selection (from ServiceSaranaSelector)
  jenis_layanan?: string[]
  layanan_lainnya?: string
  sarana?: number[]
  sarana_lainnya?: string
}

export interface WaInboxRow {
  kind: 'pending' | 'visit'
  id_kunjungan: number | null   // null untuk pending (belum jadi visit)
  session_id: number | null     // diisi untuk pending DAN visit (untuk Ambil alih)
  category: WaCategory | null   // kategori sesi (data|offline|lainnya) — untuk tombol "Kirim Form Data"
  status: string                // 'menunggu_form' untuk pending; status visit lainnya
  date: string
  nama: string | null
  nama_instansi: string | null
  notel: string | null
  permintaan: string | null
  assigned_to: number | null    // admin_users.id operator pemegang sesi (null = belum diambil)
  operator_nama: string | null  // nama operator (sudah dibersihkan), untuk chip "Ditangani"
  unread: number                // jumlah pesan masuk belum dibaca (badge tombol "Buka chat")
}

export interface WaMessage {
  id: number
  direction: 'in' | 'out'
  msg_type: 'text' | 'image' | 'document' | 'audio' | 'video' | 'sticker' | 'location' | 'contact'
  body: string | null
  media_url: string | null    // '/api/wa/media/{id}' bila ada lampiran
  media_name: string | null
  media_mime: string | null
  status: 'pending' | 'sent' | 'failed' | 'received'
  ack: number                  // 0..4 WhatsApp ack (khusus 'out'): 2=delivered ✓✓ abu, 3=read ✓✓ biru
  reaction: string | null      // emoji reaksi pada pesan ini (null = tak ada)
  quoted_msg_id: string | null // wa_msg_id pesan yang dibalas (reply) — internal, utk koneksi WA
  quoted_preview: string | null// cuplikan teks pesan yang dibalas (utk chip kutipan)
  created_at: string
}

export interface WaQrState {
  ready: boolean
  qr: string | null          // data-URL PNG while unlinked
  number: string | null
  pair_phone?: string | null    // nomor yang sedang diminta pairing (link with phone number)
  pairing_code?: string | null  // kode 8-char untuk dimasukkan di WhatsApp
  updated_at: string | null
  stale?: boolean               // connector tak berdetak > TTL (backend turunkan ready→false)
  seconds_since?: number | null // detik sejak detak terakhir (untuk pesan "offline sejak …")
}
