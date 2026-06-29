export type VisitStatus = 'antri' | 'dipanggil' | 'proses' | 'diproses' | 'menunggu_evaluasi' | 'evaluasi_selesai' | 'selesai'

export interface Visit {
  id_kunjungan: number
  id_user: number
  nama: string
  nama_instansi: string
  jenis_layanan: string
  layanan_lainnya: string | null
  sarana: string | null
  sarana_lainnya: string | null
  nomor_antrian: string | null
  status: VisitStatus
  date_visit: string
  durasi_detik: number | null
  selesai_timestamp: string | null
  rating_pengunjung: number | null
  created_by: string | null
  // Diisi oleh list endpoint (Consultations/Dtsen ::index()) via subquery:
  // jumlah baris kebutuhan/konsultasi nyata milik visit. Dipakai antrian untuk
  // membedakan "Mulai" (belum ada data) vs "Lihat/Edit" (sudah disimpan).
  // Opsional — fallback ke "Mulai" kalau backend belum redeploy.
  has_konsultasi?: number
}

/** Parse jenis_layanan — could be JSON array or plain string */
export function parseLayanan(val: string | null): string[] {
  if (!val) return []
  try {
    const parsed = JSON.parse(val)
    return Array.isArray(parsed) ? parsed : [val]
  } catch {
    return [val]
  }
}

/** Parse sarana codes from JSON array */
export function parseSarana(val: string | null): number[] {
  if (!val) return []
  try {
    const parsed = JSON.parse(val)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const SARANA_LABELS: Record<number, string> = {
  1: 'PST (datang langsung)',
  2: 'PST Online',
  4: 'Website BPS',
  9: 'Surat/Email',
  16: 'Aplikasi Chat',
  32: 'Lainnya',
  33: 'Ruang Halmahera',
  34: 'Ruang Vicon',
  35: 'Ruang Gamalama',
  36: 'Ruang Pimpinan',
}

export function saranaLabel(code: number): string {
  return SARANA_LABELS[code] ?? `Kode ${code}`
}

export interface ConsultationDataRow {
  id?: number
  rincian_data: string
  // Field-field di bawah ini tidak di-render di form SKD versi baru — di-keep di
  // schema/payload supaya tidak break, dan ditampilkan sebagai "-" di panel admin
  // (legacy data mungkin punya nilai default palsu seperti tahun saat ini).
  wilayah_data: string | null
  tahun_awal: number | null
  tahun_akhir: number | null
  level_data: number | null
  periode_data: number | null
  status_data: number
  jenis_publikasi: string | null
  judul_publikasi: string | null
  tahun_publikasi: number | null
  digunakan_nasional: number | null
  kualitas: number | null
  // Ringkasan/hasil konsultasi. Disimpan denormalized di SETIAP baris
  // konsultasi_pengunjung oleh backend; GET /data mengembalikannya. Opsional
  // karena baris yang dibuat di FE (emptyRow/seed) belum memuatnya.
  hasil_konsultasi?: string | null
}

export interface DtsenDataRow {
  id?: number
  id_kunjungan?: number
  jenis_konsultasi_dtsen: number
  hasil: number
  catatan: string | null
  nik_dirujuk: string | null
  tanggal_input?: string
}

export const JENIS_KONSULTASI_DTSEN_OPTIONS = [
  { value: 1, label: 'Verifikasi Data Penerima' },
  { value: 2, label: 'Pengaduan Data' },
  { value: 3, label: 'Permintaan Pemutakhiran' },
  { value: 4, label: 'Sanggahan/Keberatan' },
  { value: 5, label: 'Lainnya' },
] as const

export const HASIL_DTSEN_OPTIONS = [
  { value: 1, label: 'Selesai di tempat' },
  { value: 2, label: 'Perlu follow-up' },
  { value: 3, label: 'Data tidak ditemukan' },
] as const

export const LEVEL_DATA_OPTIONS = [
  { value: 1, label: 'Nasional' },
  { value: 2, label: 'Provinsi' },
  { value: 3, label: 'Kabupaten/Kota' },
  { value: 4, label: 'Kecamatan' },
  { value: 5, label: 'Desa/Kelurahan' },
  { value: 6, label: 'Individu' },
  { value: 7, label: 'Lainnya' },
] as const

export const PERIODE_DATA_OPTIONS = [
  { value: 1, label: 'Sepuluh Tahunan' },
  { value: 2, label: 'Lima Tahunan' },
  { value: 3, label: 'Tiga Tahunan' },
  { value: 4, label: 'Tahunan' },
  { value: 5, label: 'Semesteran' },
  { value: 6, label: 'Triwulanan' },
  { value: 7, label: 'Bulanan' },
  { value: 8, label: 'Mingguan' },
  { value: 9, label: 'Harian' },
  { value: 10, label: 'Lainnya' },
] as const

export const STATUS_DATA_OPTIONS = [
  { value: 1, label: 'Ya sesuai' },
  { value: 2, label: 'Ya tidak sesuai' },
  { value: 3, label: 'Tidak diperoleh' },
  { value: 4, label: 'Belum Diperoleh' },
] as const

export const JENIS_PUBLIKASI_OPTIONS = [
  'Publikasi', 'Data Mikro', 'Peta Wilkerstat', 'Tabulasi Data', 'Tabel di Website',
] as const

/** Kategori instansi yang termasuk "pemerintah" (untuk pertanyaan digunakan_nasional). */
export const KATEGORI_PEMERINTAH = [1, 2, 3, 4] as const

export function isPemerintahKategori(kategori: number | string | null | undefined): boolean {
  if (kategori === null || kategori === undefined || kategori === '') return false
  const v = Number(kategori)
  return (KATEGORI_PEMERINTAH as readonly number[]).includes(v)
}

export const SERVICE_OPTIONS = [
  'Perpustakaan',
  'Konsultasi Statistik',
  'Rekomendasi Kegiatan Statistik',
  'Penjualan Produk Statistik',
  'Keperluan Pimpinan',
  'Lainnya',
  'Konsultasi DTSEN',
  'Daftar Antrian Offline',
  'Lainnya Online',
] as const

export interface DashboardStats {
  total_kunjungan: number
  tamu_unik: number
  jumlah_hari: number
  rata_rata_per_hari: number
  hari_tersibuk: string
  periode_aktif: string
  selesai: number
  antri: number
  tingkat_selesai: number
  rata_rata_durasi: string
  layanan_terbanyak: string
  instansi_terbanyak: string
}

export interface CalendarEvent {
  id: string
  title: string
  start: string
  end?: string
  color: string
}
