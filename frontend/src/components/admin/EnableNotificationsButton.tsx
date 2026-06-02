import { useEffect, useState } from 'react'
import { BellRing, BellOff } from 'lucide-react'
import { toast } from 'sonner'
import { enablePush, pushSupported } from '@/hooks/usePushNotifications'

/**
 * Tombol "Aktifkan Notifikasi" di TopNav. Browser memblokir prompt izin tanpa
 * gesture, jadi prompt dipicu dari klik ini. Hanya tampil saat izin masih
 * 'default'. Saat 'granted' → tidak tampil. Saat 'denied' → hint cara unblock.
 */
export function EnableNotificationsButton() {
  const [perm, setPerm] = useState<NotificationPermission | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!pushSupported()) {
      setPerm(null)
      return
    }
    setPerm(Notification.permission)
    // Re-cek saat balik fokus (user mungkin ubah izin di pengaturan browser).
    const onFocus = () => setPerm(Notification.permission)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  if (perm === null || perm === 'granted') return null

  if (perm === 'denied') {
    // Izin sudah diblokir → JS tidak bisa prompt ulang. Klik = tampilkan panduan
    // reset manual di setelan browser (bukan diam saja).
    const showHelp = () =>
      toast('Notifikasi diblokir browser', {
        description:
          'Reset lewat browser: klik ikon gembok/⚙ di KIRI address bar → "Notifications/Notifikasi" → ubah ke Allow/Izinkan → refresh halaman. ' +
          'Alternatif: Settings → Privacy & security → Site Settings → Notifications → cari situs ini → Allow.',
        duration: 15000,
      })
    return (
      <button
        onClick={showHelp}
        className="admin-nav-item !gap-1.5 text-[--admin-text-muted] hover:bg-muted"
        title="Notifikasi diblokir — klik untuk panduan mengaktifkan kembali"
      >
        <BellOff className="w-4 h-4" />
        <span className="hidden lg:inline text-xs">Notif diblokir</span>
      </button>
    )
  }

  // perm === 'default'
  const handleClick = async () => {
    setBusy(true)
    try {
      const result = await enablePush()
      setPerm(result)
      if (result === 'granted') toast.success('Notifikasi desktop aktif')
      else if (result === 'denied') toast.error('Izin notifikasi ditolak')
    } catch {
      toast.error('Gagal mengaktifkan notifikasi')
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      className="admin-nav-item !gap-1.5 text-orange-600 hover:bg-orange-50"
      title="Aktifkan notifikasi desktop (Windows toast)"
    >
      <BellRing className="w-4 h-4" />
      <span className="hidden md:inline text-xs">{busy ? 'Mengaktifkan…' : 'Aktifkan Notifikasi'}</span>
    </button>
  )
}
