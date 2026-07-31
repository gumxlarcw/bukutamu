import type { Visit } from '@/types/visit'
import { StatusBadge } from '@/components/shared/StatusBadge'
import type { ReactNode } from 'react'

interface QueueListProps {
  visits: Visit[]
  renderActions: (visit: Visit) => ReactNode
  /** Pesan saat daftar kosong. Default mempertahankan teks lama supaya
   *  DtsenQueuePage tidak ikut berubah. */
  emptyMessage?: string
}

/**
 * Tampilkan TANGGAL + jam + "WIT". Sejak kedua antrian memuat semua tanggal
 * (bukan hanya hari ini), menampilkan jam saja membuat baris 22 Juli terlihat
 * sama seperti baris hari ini.
 *
 * `date_visit` datang dari MySQL sebagai "2026-07-31 10:44:17" — tanpa penanda
 * zona. Tanpa penanda, browser menafsirkannya sebagai waktu LOKAL perangkat,
 * yang keliru begitu labelnya menyatakan WIT. Sematkan +09:00 lalu render
 * dalam Asia/Jayapura supaya labelnya selalu jujur, apa pun zona perangkatnya.
 */
function formatWaktu(dateStr: string): string {
  try {
    const raw = String(dateStr).trim().replace(' ', 'T')
    const berzona = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)
    const d = new Date(berzona ? raw : `${raw}+09:00`)
    if (Number.isNaN(d.getTime())) return dateStr
    const teks = d.toLocaleString('id-ID', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Jayapura',
    })
    return `${teks} WIT`
  } catch {
    return dateStr
  }
}

export function QueueList({
  visits,
  renderActions,
  emptyMessage = 'Tidak ada antrian hari ini.',
}: QueueListProps) {
  if (visits.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        {emptyMessage}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {visits.map(visit => (
        <div
          key={visit.id_kunjungan}
          className="admin-card flex items-center gap-4 p-4"
        >
          {/* Queue number */}
          <div className="w-14 h-14 rounded-full flex items-center justify-center shrink-0" style={{ background: 'var(--admin-primary-light)' }}>
            <span className="font-bold text-lg" style={{ color: 'var(--admin-primary)' }}>
              {visit.nomor_antrian ?? '-'}
            </span>
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm truncate">{visit.nama}</p>
            <p className="text-xs text-muted-foreground truncate">{visit.jenis_layanan}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{formatWaktu(visit.date_visit)}</p>
          </div>

          {/* Status badge */}
          <StatusBadge status={visit.status} />

          {/* Actions */}
          <div className="flex items-center gap-2 shrink-0">
            {renderActions(visit)}
          </div>
        </div>
      ))}
    </div>
  )
}
