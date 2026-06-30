import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Bell, AlertOctagon, AlertTriangle, Info } from 'lucide-react'
import { notificationsApi, type AppNotification, type NotificationType } from '@/api/notifications'

/**
 * Bell icon di footer Sidebar admin. Polls /api/notifications setiap 30 detik.
 * Click bell → dropdown daftar notification. Click notification → navigate ke action_url.
 *
 * Design choices:
 * - Polling 30s = balance antara real-time feel & server load. Bisa diturunkan ke 15s
 *   kalau perlu lebih responsif, atau dinaikkan ke 60s untuk hemat resource.
 * - Dropdown ditutup click-outside via document mousedown listener (Radix dropdown
 *   tidak dipakai supaya badge count + animation di trigger lebih leluasa).
 * - Bell duduk di pojok KIRI-BAWAH sidebar, jadi panel dibuka ke ATAS + KANAN
 *   (`bottom-full left-0`). Kalau pakai `right-0 top-full` (warisan layout TopNav lama)
 *   panel tumbuh ke kiri-bawah & lolos dari viewport → user tak bisa klik isinya dan
 *   click-outside langsung menutupnya.
 * - Tidak persist "read state" — semua notification ter-render sampai backend
 *   tidak return-nya lagi (akar masalahnya hilang). Konsisten dengan filosofi
 *   "notification = derived state" di backend.
 */
export function NotificationBell() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => notificationsApi.list().then(r => r.data.data),
    refetchInterval: 30_000,
    staleTime: 25_000,
  })

  const notifs = data?.notifications ?? []
  const count = data?.count ?? 0

  // Click-outside to close dropdown
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleClick = (n: AppNotification) => {
    setOpen(false)
    navigate(n.action_url)
  }

  const hasCritical = notifs.some(n => n.type === 'critical')

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="relative admin-nav-item !p-2"
        title={count > 0 ? `${count} notifikasi` : 'Tidak ada notifikasi'}
        aria-label="Notifikasi"
      >
        <Bell className={`w-4 h-4 ${count > 0 ? 'text-orange-600' : 'text-[--admin-text-muted]'}`} />
        {count > 0 && (
          <span
            className={`absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full text-[10px] font-bold text-white flex items-center justify-center tabular-nums ${
              hasCritical ? 'bg-red-600 animate-pulse' : 'bg-orange-500'
            }`}
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 bottom-full mb-2 w-[360px] max-w-[calc(100vw-32px)] rounded-xl bg-white border border-[--admin-border-strong] shadow-xl overflow-hidden z-50">
          <div className="px-4 py-3 border-b border-[--admin-border] bg-[--admin-bg]">
            <p className="text-sm font-bold text-[--admin-text]">Notifikasi</p>
            <p className="text-[11px] text-[--admin-text-muted]">{count} item perlu perhatian</p>
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {notifs.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-[--admin-text-muted]">
                <Bell className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p>Tidak ada notifikasi saat ini</p>
                <p className="text-[11px] mt-1">Semua tugas sudah lengkap.</p>
              </div>
            ) : (
              notifs.map(n => <NotificationItem key={n.id} notif={n} onClick={() => handleClick(n)} />)
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function NotificationItem({ notif, onClick }: { notif: AppNotification; onClick: () => void }) {
  const meta = severityMeta(notif.type)
  const Icon = meta.icon
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-4 py-3 hover:bg-[--admin-bg] border-b border-[--admin-border] last:border-b-0 transition-colors group"
    >
      <div className="flex items-start gap-3">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${meta.bg}`}>
          <Icon className={`w-4 h-4 ${meta.text}`} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-[--admin-text] leading-tight group-hover:text-[--admin-primary] transition-colors">
            {notif.title}
          </p>
          <p className="text-xs text-[--admin-text-muted] mt-0.5 leading-snug">{notif.message}</p>
          {notif.count !== undefined && notif.count > 1 && (
            <p className="text-[10px] text-[--admin-text-muted] mt-1 font-medium">
              {notif.count} item
            </p>
          )}
        </div>
      </div>
    </button>
  )
}

function severityMeta(type: NotificationType): { icon: typeof Bell; bg: string; text: string } {
  if (type === 'critical') return { icon: AlertOctagon, bg: 'bg-red-100',    text: 'text-red-700' }
  if (type === 'warning')  return { icon: AlertTriangle, bg: 'bg-amber-100', text: 'text-amber-700' }
  return                          { icon: Info,          bg: 'bg-sky-100',   text: 'text-sky-700' }
}
