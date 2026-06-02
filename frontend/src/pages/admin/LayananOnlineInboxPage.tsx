import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { waApi } from '@/api/wa'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { MessageSquare, ExternalLink } from 'lucide-react'
import type { WaInboxRow } from '@/types/wa'

const STATUS_LABEL: Record<string, string> = {
  antri: 'Baru', dipanggil: 'Baru', proses: 'Diproses', diproses: 'Diproses',
  menunggu_evaluasi: 'Menunggu Evaluasi', selesai: 'Selesai',
}

export default function LayananOnlineInboxPage() {
  const navigate = useNavigate()
  const { data, isLoading } = useQuery({
    queryKey: ['wa-inbox'],
    queryFn: () => waApi.inbox().then(r => r.data.data),
    refetchInterval: 30000,
  })

  if (isLoading) return <Skeleton className="h-64 w-full" />
  const rows = data ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <MessageSquare className="w-5 h-5 text-emerald-600" />
        <h1 className="text-xl font-bold">Layanan Online (WhatsApp)</h1>
      </div>
      {rows.length === 0 && <p className="text-sm text-muted-foreground">Belum ada permintaan online.</p>}
      <div className="space-y-2">
        {rows.map((r: WaInboxRow) => (
          <div key={r.id_kunjungan} className="border rounded-lg p-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-semibold truncate">{r.nama || '(tanpa nama)'} <span className="text-xs text-muted-foreground">· {r.nama_instansi}</span></p>
              <p className="text-xs text-muted-foreground truncate">{r.permintaan || '—'}</p>
              <p className="text-[11px] text-muted-foreground">{r.notel} · WA-{r.id_kunjungan} · {STATUS_LABEL[r.status] ?? r.status}</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => navigate(`/admin/consultations/${r.id_kunjungan}/form`)}>
              <ExternalLink className="w-4 h-4 mr-1" /> Proses
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}
