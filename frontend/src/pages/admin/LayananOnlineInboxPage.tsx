import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { waApi } from '@/api/wa'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { MessageSquare, ExternalLink, CheckCircle2 } from 'lucide-react'
import type { WaInboxRow } from '@/types/wa'

const STATUS_LABEL: Record<string, string> = {
  antri: 'Baru', dipanggil: 'Baru', proses: 'Diproses', diproses: 'Diproses',
  menunggu_evaluasi: 'Menunggu Evaluasi', selesai: 'Selesai',
}

// Panel koneksi WhatsApp: tampilkan QR (dari connector via backend) untuk discan,
// atau status "terhubung". Polling tiap 6 dtk supaya QR selalu segar.
function WaConnectPanel() {
  const { data } = useQuery({
    queryKey: ['wa-qr-state'],
    queryFn: () => waApi.getQrState().then(r => r.data.data),
    refetchInterval: 6000,
  })

  if (!data) return null

  if (data.ready) {
    return (
      <div className="border rounded-lg p-3 flex items-center gap-2 bg-emerald-50 border-emerald-200">
        <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
        <p className="text-sm">
          WhatsApp <b>terhubung</b>{data.number ? ` — ${data.number}` : ''}. Connector siap menerima permintaan.
        </p>
      </div>
    )
  }

  return (
    <div className="border rounded-xl p-4 bg-amber-50 border-amber-200 text-center space-y-2">
      <p className="font-semibold text-amber-800">WhatsApp belum terhubung — scan untuk menautkan</p>
      {data.qr ? (
        <>
          <img src={data.qr} alt="QR WhatsApp" className="mx-auto rounded" style={{ width: 280, height: 280 }} />
          <p className="text-xs text-muted-foreground">
            Di HP: WhatsApp → <b>Perangkat Tertaut</b> → <b>Tautkan Perangkat</b> → scan. QR menyegar otomatis.
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Menyiapkan QR… pastikan service <code>bukutamu-wa</code> berjalan.
        </p>
      )}
    </div>
  )
}

export default function LayananOnlineInboxPage() {
  const navigate = useNavigate()
  const { data, isLoading } = useQuery({
    queryKey: ['wa-inbox'],
    queryFn: () => waApi.inbox().then(r => r.data.data),
    refetchInterval: 30000,
  })

  const rows = data ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <MessageSquare className="w-5 h-5 text-emerald-600" />
        <h1 className="text-xl font-bold">Layanan Online (WhatsApp)</h1>
      </div>

      <WaConnectPanel />

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
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
        </>
      )}
    </div>
  )
}
