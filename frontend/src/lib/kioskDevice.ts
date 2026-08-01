/**
 * Token perangkat kiosk.
 *
 * /api/kiosk/face-data dan /api/kiosk/guest-list mengembalikan SELURUH himpunan
 * tamu — termasuk 128-dimensi descriptor wajah — dan dulu bisa diunduh siapa pun
 * tanpa autentikasi (docs/AUDIT_2026-08-01.md temuan #1). Keduanya kini dijaga
 * token perangkat berumur panjang.
 *
 * Token TIDAK boleh ditanam di bundle: berkas JS kiosk disajikan publik di
 * /kiosk, jadi rahasia apa pun di dalamnya bisa dibaca siapa saja yang membuka
 * halaman itu. Karena itu token disimpan per-MESIN di localStorage dan
 * diprovisikan sekali lewat /admin/kiosk-aktivasi oleh admin yang login DI mesin
 * kiosk tersebut.
 *
 * Konsekuensinya: localStorage terikat origin + profil browser. Mengganti
 * browser, membuat profil baru, atau membersihkan data situs = perlu aktivasi
 * ulang. Itu memang trade-off yang dipilih; alternatifnya (allowlist IP) rapuh
 * karena rentang IP kantor tampak dinamis.
 */

const STORAGE_KEY = 'bukutamu.kiosk_device_token'

/** Token perangkat mesin ini, atau null bila kiosk belum diaktifkan. */
export function getKioskDeviceToken(): string | null {
  try {
    const t = localStorage.getItem(STORAGE_KEY)
    return t && t.trim() !== '' ? t : null
  } catch {
    // localStorage bisa melempar di mode privat / storage terkunci. Perlakukan
    // sebagai "belum aktif" — jangan sampai membuat halaman kiosk crash.
    return null
  }
}

export function setKioskDeviceToken(token: string): void {
  localStorage.setItem(STORAGE_KEY, token)
}

export function clearKioskDeviceToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * Header untuk permintaan kiosk yang butuh token perangkat.
 * Mengembalikan objek KOSONG bila belum aktif, sehingga permintaannya tetap
 * terkirim dan backend yang menolak dengan 401 — pesan galatnya jadi jujur
 * ("Kiosk token diperlukan") alih-alih gagal diam-diam di sisi klien.
 */
export function kioskDeviceHeader(): Record<string, string> {
  const t = getKioskDeviceToken()
  return t ? { 'X-Kiosk-Token': t } : {}
}

/** Apakah galat ini berarti "kiosk belum/tidak lagi diaktifkan"? */
export function isKioskNotActivated(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status
  return status === 401 || status === 403
}
