import { StatsCard } from '@/components/admin/StatsCard'
import type { QueueCounts } from '@/types/api'
import type { QueueStage } from '@/lib/queue-stages'
import { CircleHelp } from 'lucide-react'

interface QueueStatusCardsProps {
  /** Hitungan dari backend. Tidak dirender kalau belum tiba. */
  counts?: QueueCounts
  /** Tahapan yang ditampilkan — TAHAP_SKD atau TAHAP_DTSEN dari @/lib/queue-stages. */
  stages: QueueStage[]
}

export function QueueStatusCards({ counts, stages }: QueueStatusCardsProps) {
  if (!counts) return null

  const jumlah = (s: QueueStage) => s.statuses.reduce((t, k) => t + (counts[k] ?? 0), 0)

  // Jaring pengaman: kalau ada status yang TIDAK tercakup kartu mana pun tapi
  // jumlahnya bukan nol, tampilkan sebagai "Lainnya". Menyembunyikan baris secara
  // diam-diam persis masalah yang seluruh perubahan ini ingin hapus — jangan
  // sampai kartu ringkasannya sendiri yang mengulanginya.
  const tercakup = new Set(stages.flatMap(s => s.statuses))
  const sisa = (Object.keys(counts) as (keyof QueueCounts)[])
    .filter(k => !tercakup.has(k))
    .reduce((t, k) => t + (counts[k] ?? 0), 0)

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {stages.map(s => (
        <StatsCard key={s.label} label={s.label} value={jumlah(s)} icon={s.icon} accent={s.accent} />
      ))}
      {sisa > 0 && (
        <StatsCard
          label="Lainnya"
          value={sisa}
          icon={<CircleHelp className="w-5 h-5" />}
          accent="secondary"
        />
      )}
    </div>
  )
}
