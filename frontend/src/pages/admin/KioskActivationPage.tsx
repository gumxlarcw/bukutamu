import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { kioskApi } from '@/api/kiosk'
import { getKioskDeviceToken, setKioskDeviceToken, clearKioskDeviceToken } from '@/lib/kioskDevice'
import { getApiErrorMessage } from '@/lib/apiError'
import { Button } from '@/components/ui/button'
import { MonitorCheck, ShieldCheck, ShieldAlert, Trash2 } from 'lucide-react'

/**
 * Aktivasi perangkat kiosk.
 *
 * HARUS dibuka DI MESIN KIOSK ITU SENDIRI — token disimpan di localStorage mesin
 * yang membuka halaman ini. Membukanya di laptop admin hanya mengaktifkan laptop
 * tersebut, bukan kiosknya.
 *
 * Latar: /api/kiosk/face-data mengembalikan nama + descriptor wajah 128 dimensi
 * seluruh tamu dan dulu bisa diunduh tanpa autentikasi
 * (docs/AUDIT_2026-08-01.md temuan #1).
 *
 * Catatan UI: proyek ini TIDAK memasang <Toaster/> di mana pun, jadi toast tidak
 * pernah tampil. Status ditampilkan inline.
 */
export default function KioskActivationPage() {
  const [token, setToken] = useState<string | null>(getKioskDeviceToken())
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const activate = useMutation({
    mutationFn: () => kioskApi.mintDeviceToken().then(r => r.data.data),
    onSuccess: (d) => {
      setKioskDeviceToken(d.kiosk_token)
      setToken(d.kiosk_token)
      setExpiresAt(d.expires_at)
      setError(null)
    },
    onError: (e) => setError(getApiErrorMessage(e, 'Gagal menerbitkan token perangkat.')),
  })

  const active = token !== null

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h1 className="text-xl font-bold flex items-center gap-2">
          <MonitorCheck className="w-5 h-5 text-orange-500" />
          Aktivasi Perangkat Kiosk
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Halaman ini mendaftarkan <strong>mesin yang sedang Anda pakai</strong> sebagai kiosk
          tepercaya. Buka halaman ini <strong>di komputer kiosk</strong>, bukan di laptop Anda.
        </p>
      </div>

      <div
        className={`rounded-xl border p-4 flex items-start gap-3 ${
          active ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'
        }`}
      >
        {active ? (
          <ShieldCheck className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
        ) : (
          <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
        )}
        <div className="min-w-0">
          <p className={`font-semibold ${active ? 'text-green-800' : 'text-amber-800'}`}>
            {active ? 'Mesin ini SUDAH aktif sebagai kiosk' : 'Mesin ini BELUM aktif'}
          </p>
          <p className="text-sm text-muted-foreground mt-0.5">
            {active
              ? 'Pengenalan wajah dan daftar tamu di halaman kiosk akan berfungsi pada mesin ini.'
              : 'Halaman kiosk tidak akan bisa memuat data pengenalan wajah sampai diaktifkan.'}
          </p>
          {expiresAt && (
            <p className="text-xs text-muted-foreground mt-1">Berlaku sampai {expiresAt}</p>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      <div className="flex gap-3">
        <Button onClick={() => activate.mutate()} disabled={activate.isPending}>
          {activate.isPending ? 'Menerbitkan…' : active ? 'Terbitkan Ulang Token' : 'Aktifkan Mesin Ini'}
        </Button>
        {active && (
          <Button
            variant="outline"
            onClick={() => {
              clearKioskDeviceToken()
              setToken(null)
              setExpiresAt(null)
            }}
          >
            <Trash2 className="w-4 h-4 mr-2" />
            Hapus Token dari Mesin Ini
          </Button>
        )}
      </div>

      <div className="rounded-xl border bg-muted/30 p-4 text-sm space-y-2">
        <p className="font-semibold">Catatan operasional</p>
        <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
          <li>Token tersimpan per-browser dan per-profil. Ganti browser, profil baru, atau
            membersihkan data situs = perlu aktivasi ulang.</li>
          <li>Token berlaku 180 hari. Terbitkan ulang sebelum masa berlakunya habis.</li>
          <li>Setelah aktivasi, Anda boleh logout — kiosk tidak memerlukan sesi admin.</li>
          <li>Belum ada pencabutan per-perangkat: mencabut satu token berarti memutar
            <code className="mx-1">JWT_SECRET</code>, yang membatalkan SEMUA token sekaligus.</li>
        </ul>
      </div>
    </div>
  )
}
