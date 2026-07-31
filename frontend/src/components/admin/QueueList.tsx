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

function formatTime(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
    })
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
            <p className="text-xs text-muted-foreground mt-0.5">{formatTime(visit.date_visit)}</p>
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
