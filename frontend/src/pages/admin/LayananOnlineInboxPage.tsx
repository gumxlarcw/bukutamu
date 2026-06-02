import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { waApi } from '@/api/wa'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { StatsCard } from '@/components/admin/StatsCard'
import { EmptyState } from '@/components/shared/EmptyState'
import { MessageSquare, ExternalLink, CheckCircle2, Inbox, Clock, Hourglass, CircleCheck } from 'lucide-react'
import type { WaInboxRow } from '@/types/wa'

function formatWhen(iso: string): string {
  if (!iso) return '-'
  const d = new Date(iso.replace(' ', 'T'))
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/* ── Panel koneksi WhatsApp: QR untuk discan, atau status terhubung ───────── */
function WaConnectPanel() {
  const { data } = useQuery({
    queryKey: ['wa-qr-state'],
    queryFn: () => waApi.getQrState().then(r => r.data.data),
    refetchInterval: 6000,
  })

  if (!data) return null

  // Terhubung → strip hijau ramping.
  if (data.ready) {
    return (
      <div className="admin-card p-3.5 flex items-center gap-3">
        <span className="w-9 h-9 rounded-full bg-emerald-50 flex items-center justify-center shrink-0">
          <CheckCircle2 className="w-5 h-5 text-emerald-600" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold" style={{ color: 'var(--admin-text)' }}>WhatsApp terhubung</p>
          <p className="text-xs truncate" style={{ color: 'var(--admin-text-muted)' }}>
            Nomor {data.number ?? '—'} · connector siap menerima permintaan
          </p>
        </div>
      </div>
    )
  }

  // Belum terhubung → kartu QR yang jelas.
  return (
    <div className="admin-card p-6">
      <div className="flex flex-col sm:flex-row items-center gap-6">
        {data.qr ? (
          <div className="bg-white p-3 rounded-xl shrink-0" style={{ boxShadow: 'var(--admin-shadow)', border: '1px solid var(--admin-border)' }}>
            <img src={data.qr} alt="QR WhatsApp" className="w-[230px] h-[230px] block" />
          </div>
        ) : (
          <div className="w-[254px] h-[254px] rounded-xl shrink-0 flex flex-col items-center justify-center gap-3 bg-[var(--admin-primary-light)]">
            <Hourglass className="w-7 h-7 text-[var(--admin-primary)] animate-pulse" />
            <p className="text-xs text-center px-6" style={{ color: 'var(--admin-text-muted)' }}>Menyiapkan QR… pastikan service <code>bukutamu-wa</code> berjalan.</p>
          </div>
        )}

        <div className="text-center sm:text-left space-y-3 min-w-0">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-100 text-amber-700 text-xs font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            Belum terhubung
          </span>
          <h2 className="text-base font-bold" style={{ color: 'var(--admin-text)' }}>Hubungkan nomor WhatsApp layanan</h2>
          <ol className="text-sm space-y-1.5 list-decimal list-inside" style={{ color: 'var(--admin-text-secondary)' }}>
            <li>Buka WhatsApp di HP nomor layanan</li>
            <li>Menu <b>Perangkat Tertaut</b> → <b>Tautkan Perangkat</b></li>
            <li>Arahkan kamera ke QR di samping</li>
          </ol>
          <p className="text-[11px]" style={{ color: 'var(--admin-text-muted)' }}>QR menyegar otomatis setiap beberapa detik.</p>
        </div>
      </div>
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

  const rows: WaInboxRow[] = data ?? []
  const counts = {
    baru: rows.filter(r => r.status === 'antri' || r.status === 'dipanggil').length,
    diproses: rows.filter(r => r.status === 'proses' || r.status === 'diproses').length,
    evaluasi: rows.filter(r => r.status === 'menunggu_evaluasi').length,
    selesai: rows.filter(r => r.status === 'selesai').length,
  }

  return (
    <div className="space-y-5 admin-enter">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="admin-h1">Layanan Online</h1>
          <p className="admin-subtitle">Permintaan data via WhatsApp — antrian online PST, diperbarui otomatis</p>
        </div>
      </div>

      {/* Koneksi WhatsApp */}
      <WaConnectPanel />

      {/* Ringkasan status */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatsCard label="Baru" value={counts.baru} icon={<Inbox className="w-5 h-5" />} accent="primary" />
        <StatsCard label="Diproses" value={counts.diproses} icon={<Clock className="w-5 h-5" />} accent="secondary" />
        <StatsCard label="Menunggu Evaluasi" value={counts.evaluasi} icon={<Hourglass className="w-5 h-5" />} accent="primary" />
        <StatsCard label="Selesai" value={counts.selesai} icon={<CircleCheck className="w-5 h-5" />} accent="secondary" />
      </div>

      {/* Daftar permintaan */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon="💬" message="Belum ada permintaan online" action="Permintaan dari WhatsApp akan muncul di sini." />
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.id_kunjungan} className="admin-card flex items-center gap-4 p-4">
              <div className="w-12 h-12 rounded-full flex items-center justify-center shrink-0 bg-emerald-50">
                <MessageSquare className="w-5 h-5 text-emerald-600" />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 min-w-0">
                  <p className="font-semibold text-sm truncate" style={{ color: 'var(--admin-text)' }}>
                    {r.nama || '(tanpa nama)'}
                  </p>
                  {r.nama_instansi && (
                    <span className="text-xs truncate" style={{ color: 'var(--admin-text-muted)' }}>· {r.nama_instansi}</span>
                  )}
                </div>
                <p className="text-xs truncate mt-0.5" style={{ color: 'var(--admin-text-secondary)' }}>
                  {r.permintaan || 'Permintaan belum dilengkapi'}
                </p>
                <p className="text-[11px] mt-1 flex items-center gap-1.5 flex-wrap" style={{ color: 'var(--admin-text-muted)' }}>
                  <span className="font-mono font-medium px-1.5 py-0.5 rounded bg-[var(--admin-primary-light)] text-[var(--admin-primary)]">WA-{r.id_kunjungan}</span>
                  <span>{r.notel || '—'}</span>
                  <span>·</span>
                  <span>{formatWhen(r.date_visit)}</span>
                </p>
              </div>

              <StatusBadge status={r.status} />

              <Button size="sm" variant="outline" className="shrink-0" onClick={() => navigate(`/admin/consultations/${r.id_kunjungan}/form`)}>
                <ExternalLink className="w-3.5 h-3.5 mr-1" /> Proses
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
