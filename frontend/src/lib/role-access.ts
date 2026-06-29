import type { UserRole } from '@/api/auth'

// 4 layanan inti SKD — butuh form evaluasi SKD setelah selesai.
const SKD_SERVICES = [
  'Perpustakaan',
  'Konsultasi Statistik',
  'Rekomendasi Kegiatan Statistik',
  'Penjualan Produk Statistik',
] as const

// Layanan PST di luar SKD — tetap ditangani petugas_pst & pakai panggilan TV,
// tapi tidak memicu evaluasi SKD (langsung selesai setelah finalisasi).
// 'Lainnya Online' = WA category #3: PST handles via chat, finishes to 'selesai' (no eval).
const DTSEN_SERVICES = ['Konsultasi DTSEN', 'Lainnya Online'] as const

// Semua layanan yang ditangani petugas_pst (role-wise).
const PST_SERVICES = [...SKD_SERVICES, ...DTSEN_SERVICES] as const

// 'Daftar Antrian Offline' = WA category #2: front-office pre-registration.
// Label is overwritten with the real service at kiosk promotion (created_by='wa_kiosk').
const RESEPSIONIS_SERVICES = ['Lainnya', 'Keperluan Pimpinan', 'Daftar Antrian Offline'] as const

const BYPASS_ROLES: UserRole[] = ['superadmin', 'admin', 'operator']

export function parseLayananForRole(jenis_layanan: string | null | undefined): string[] {
  if (!jenis_layanan) return []
  const trimmed = jenis_layanan.trim()
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      return Array.isArray(parsed) ? parsed.map(String) : [trimmed]
    } catch {
      return [trimmed]
    }
  }
  return [trimmed]
}

/**
 * Cermin dari Api_base::require_layanan_role di backend.
 * Mengembalikan true jika role user boleh menyelesaikan (selesai/menunggu_evaluasi)
 * sebuah visit dengan kombinasi layanan tertentu.
 */
export function canFinalizeLayanan(role: UserRole | undefined, layanan_list: string[]): boolean {
  if (!role) return false
  if (BYPASS_ROLES.includes(role)) return true

  for (const layanan of layanan_list) {
    const isPst = (PST_SERVICES as readonly string[]).includes(layanan)
    const isResep = (RESEPSIONIS_SERVICES as readonly string[]).includes(layanan)

    if (isPst && role !== 'petugas_pst') return false
    if (isResep && role !== 'resepsionis') return false
  }
  return true
}

/**
 * Cermin Api_base::next_status_after_completion. Tentukan status finalisasi:
 * - SKD (4 layanan inti) → 'menunggu_evaluasi' (perlu evaluasi di tablet)
 * - DTSEN → 'selesai' langsung (PST role tapi di luar kuesioner SKD)
 * - Resepsionis (Lainnya, Keperluan Pimpinan) → 'selesai' langsung
 * - Multi-layanan: jika ada layanan SKD, evaluasi tetap dibutuhkan.
 * Catatan: backend perlu disinkronkan agar DTSEN tidak memicu evaluasi.
 */
export function nextStatusAfterCompletion(layanan_list: string[]): 'menunggu_evaluasi' | 'selesai' {
  for (const layanan of layanan_list) {
    if ((SKD_SERVICES as readonly string[]).includes(layanan)) {
      return 'menunggu_evaluasi'
    }
  }
  return 'selesai'
}

/** Apakah layanan ini termasuk 4 inti SKD (butuh evaluasi tablet). */
export function isSkdLayanan(name: string): boolean {
  return (SKD_SERVICES as readonly string[]).includes(name)
}

/** Apakah layanan ini DTSEN (PST role-wise tapi tanpa SKD). */
export function isDtsenLayanan(name: string): boolean {
  return (DTSEN_SERVICES as readonly string[]).includes(name)
}

/**
 * Apakah visit dengan kombinasi layanan ini butuh fitur Panggil (TV + TTS)?
 * - PST: ya (tamu duduk di ruang tunggu, dipanggil via layar TV)
 * - Resepsionis (Lainnya, Keperluan Pimpinan): tidak (face-to-face, tamu langsung di depan resepsionis)
 */
export function needsQueueCall(layanan_list: string[]): boolean {
  return layanan_list.some(l => (PST_SERVICES as readonly string[]).includes(l))
}

export function isPstLayanan(name: string): boolean {
  return (PST_SERVICES as readonly string[]).includes(name)
}

export function isResepsionisLayanan(name: string): boolean {
  return (RESEPSIONIS_SERVICES as readonly string[]).includes(name)
}

export type ServiceGroup = 'SKD' | 'DTSEN' | 'RESEPSIONIS'

/** Tentukan grup sebuah layanan, atau null jika tidak dikenal. */
export function getServiceGroup(name: string): ServiceGroup | null {
  if ((SKD_SERVICES as readonly string[]).includes(name)) return 'SKD'
  if ((DTSEN_SERVICES as readonly string[]).includes(name)) return 'DTSEN'
  if ((RESEPSIONIS_SERVICES as readonly string[]).includes(name)) return 'RESEPSIONIS'
  return null
}

/** Grup aktif dari daftar layanan terpilih (asumsi tidak cross). Null kalau kosong. */
export function getActiveServiceGroup(layanan_list: string[]): ServiceGroup | null {
  for (const l of layanan_list) {
    const g = getServiceGroup(l)
    if (g) return g
  }
  return null
}

/**
 * Cek apakah kombinasi layanan ini "cross" (mencampur 2+ grup berbeda).
 * Strategi C: tamu HARUS pilih satu grup saja (SKD / DTSEN / Resepsionis).
 */
export function isCrossLayanan(layanan_list: string[]): boolean {
  const groups = new Set<ServiceGroup>()
  for (const l of layanan_list) {
    const g = getServiceGroup(l)
    if (g) groups.add(g)
    if (groups.size > 1) return true
  }
  return false
}

/**
 * Cek apakah penambahan layanan baru akan membuat kombinasi cross.
 * Dipakai untuk disable tombol di kiosk service selector.
 */
export function wouldBeCross(currentList: string[], newLayanan: string): boolean {
  if (currentList.includes(newLayanan)) return false // already selected, deselecting OK
  return isCrossLayanan([...currentList, newLayanan])
}

// Whitelist sarana per grup layanan. Kode sarana didefinisikan di src/types/guest.ts.
// - SKD: 6 sarana standar BPS (PST datang/online, Website, Surat, Chat, Lainnya).
// - DTSEN: hanya PST datang langsung (konsultasi tatap muka di kantor).
// - RESEPSIONIS: 4 ruangan internal (Halmahera/Vicon/Gamalama/Pimpinan).
const SARANA_BY_GROUP: Record<ServiceGroup, readonly number[]> = {
  SKD: [1, 2, 4, 9, 16, 32],
  DTSEN: [1],
  RESEPSIONIS: [33, 34, 35, 36],
}

/** Sarana yang valid untuk daftar layanan terpilih. Kosong kalau belum pilih layanan. */
export function getAllowedSaranaCodes(layanan_list: string[]): readonly number[] {
  const group = getActiveServiceGroup(layanan_list)
  return group ? SARANA_BY_GROUP[group] : []
}

/** Apakah satu kode sarana boleh dipilih untuk kombinasi layanan ini. */
export function isSaranaAllowed(saranaCode: number, layanan_list: string[]): boolean {
  return getAllowedSaranaCodes(layanan_list).includes(saranaCode)
}
