import { Badge } from '@/components/ui/badge'
import type { VisitStatus } from '@/types/visit'

const STATUS_CONFIG: Record<VisitStatus, { label: string; className: string }> = {
  antri:             { label: 'Antri',             className: 'bg-gray-500 text-white' },
  dipanggil:         { label: 'Dipanggil',         className: 'bg-orange-500 text-white' },
  proses:            { label: 'Proses',            className: 'bg-blue-500 text-white' },
  diproses:          { label: 'Diproses',          className: 'bg-blue-500 text-white' },
  menunggu_evaluasi: { label: 'Menunggu Evaluasi', className: 'bg-amber-500 text-white' },
  evaluasi_selesai:  { label: 'Evaluasi Selesai',  className: 'bg-teal-500 text-white' },
  selesai:           { label: 'Selesai',           className: 'bg-green-500 text-white' },
}

const FALLBACK = { label: 'Unknown', className: 'bg-gray-300 text-gray-700' }

export function StatusBadge({ status }: { status: VisitStatus | string }) {
  const config = STATUS_CONFIG[status as VisitStatus] ?? FALLBACK
  return <Badge className={config.className}>{config.label}</Badge>
}
