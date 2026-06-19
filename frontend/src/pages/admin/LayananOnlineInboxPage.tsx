import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { waApi } from '@/api/wa'
import { visitsApi } from '@/api/visits'
import { useAuth } from '@/providers/AuthProvider'
import { ChatPopup } from '@/components/wa/ChatPopup'
import ConsultationFormPage from '@/pages/admin/ConsultationFormPage'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { StatsCard } from '@/components/admin/StatsCard'
import { EmptyState } from '@/components/shared/EmptyState'
import { MessageSquare, MessageCircle, ExternalLink, Inbox, Clock, Hourglass, CircleCheck, Unplug, Send, Trash2, QrCode, Smartphone, Copy, Loader2, RefreshCw, ArrowRight, Hand, UserCheck } from 'lucide-react'
import type { WaInboxRow } from '@/types/wa'

function formatWhen(iso: string): string {
  if (!iso) return '-'
  const d = new Date(iso.replace(' ', 'T'))
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/* CSS bersama panel: entrance, pulse online, scan-line QR, pop OTP. Live update via polling. */
const WA_PANEL_STYLE = (
  <style>{`
    @keyframes waPanelIn { from {opacity:0; transform:translateY(8px);} to {opacity:1; transform:translateY(0);} }
    .wa-in { animation: waPanelIn .4s cubic-bezier(.16,1,.3,1); }
    @keyframes waPulse { 0%,100% {box-shadow:0 0 0 0 rgba(16,185,129,.55);} 60% {box-shadow:0 0 0 7px rgba(16,185,129,0);} }
    .wa-dot { animation: waPulse 1.9s ease-out infinite; }
    @keyframes waScan { 0% {top:4%;} 50% {top:92%;} 100% {top:4%;} }
    .wa-scan { animation: waScan 2.6s ease-in-out infinite; }
    @keyframes waTile { from {opacity:0; transform:translateY(8px) scale(.8);} to {opacity:1; transform:translateY(0) scale(1);} }
    .wa-tile { animation: waTile .4s cubic-bezier(.16,1,.3,1) both; }
  `}</style>
)

/* ── Panel koneksi WhatsApp — linking console (QR / pairing code), live-update tanpa reload ── */
function WaConnectPanel() {
  const qc = useQueryClient()
  const { data, isFetching } = useQuery({
    queryKey: ['wa-qr-state'],
    queryFn: () => waApi.getQrState().then(r => r.data.data),
    refetchInterval: 4000,            // live update halus tanpa reload
    placeholderData: (prev) => prev,  // jangan flicker antar-poll
  })
  const disconnect = useMutation({
    mutationFn: () => waApi.disconnect(),
    onSuccess: () => {
      toast.success('Memutuskan koneksi… QR baru akan muncul (±10–15 detik).')
      qc.invalidateQueries({ queryKey: ['wa-qr-state'] })
    },
    onError: () => toast.error('Gagal memutuskan koneksi'),
  })
  const [pairPhone, setPairPhone] = useState('')
  const [mode, setMode] = useState<'qr' | 'phone'>('qr')
  const pair = useMutation({
    mutationFn: (phone: string) => waApi.requestPair(phone),
    onSuccess: (_d, phone) => {
      toast.success(phone ? 'Meminta kode tautan…' : 'Dibatalkan, kembali ke QR.')
      qc.invalidateQueries({ queryKey: ['wa-qr-state'] })
    },
    onError: () => toast.error('Gagal memproses permintaan'),
  })

  if (!data) return <div className="admin-card p-4"><Skeleton className="h-20 rounded-xl" /></div>

  // ── TERHUBUNG ──
  if (data.ready) {
    return (
      <div className="admin-card wa-in relative overflow-hidden">
        {WA_PANEL_STYLE}
        <div className="absolute inset-0 pointer-events-none opacity-[0.05]"
             style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, #0e7c63 1px, transparent 0)', backgroundSize: '14px 14px' }} />
        <div className="relative flex items-center gap-3.5 p-4">
          <div className="relative shrink-0">
            <span className="w-12 h-12 rounded-2xl grid place-items-center shadow-sm" style={{ background: 'linear-gradient(135deg,#25D366,#0e7c63)' }}>
              <MessageCircle className="w-6 h-6 text-white" />
            </span>
            <span className="wa-dot absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-emerald-400" style={{ border: '2.5px solid var(--admin-surface)' }} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="text-sm font-bold" style={{ color: 'var(--admin-text)' }}>WhatsApp Terhubung</p>
              <span className="text-[10px] font-bold tracking-wide px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600">● ONLINE</span>
            </div>
            <p className="text-xs font-mono mt-0.5 truncate" style={{ color: 'var(--admin-text-muted)' }}>
              {data.number ? '+' + data.number : '—'} · connector siap menerima permintaan
            </p>
          </div>
          <Button size="sm" variant="outline" className="shrink-0 text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
            disabled={disconnect.isPending}
            onClick={() => { if (window.confirm('Putuskan WhatsApp dan ganti nomor? Connector akan menampilkan QR baru untuk discan.')) disconnect.mutate() }}>
            <Unplug className="w-3.5 h-3.5 mr-1" /> {disconnect.isPending ? 'Memutuskan…' : 'Putuskan & Ganti Nomor'}
          </Button>
        </div>
      </div>
    )
  }

  // ── TERTAUT TAPI TIDAK MERESPONS (connector mati/hang) ──
  // Nomor sudah tertaut, tapi backend tak menerima detak > TTL → bukan "belum terhubung".
  // Tampilkan peringatan agar petugas RESTART service, bukan jatuh ke konsol scan QR (yang
  // menyiratkan "belum pernah ditautkan"). Ini fallback manusia yang hilang saat outage 36 jam.
  if (data.stale && data.number) {
    return (
      <div className="admin-card wa-in p-4 flex items-center gap-3.5 border border-red-200" style={{ background: 'rgba(254,242,242,0.7)' }}>
        {WA_PANEL_STYLE}
        <span className="w-12 h-12 rounded-2xl grid place-items-center shrink-0 bg-red-100">
          <Unplug className="w-6 h-6 text-red-600" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-bold text-red-700">Connector WhatsApp tidak merespons</p>
            <span className="text-[10px] font-bold tracking-wide px-1.5 py-0.5 rounded-full bg-red-100 text-red-600">● OFFLINE</span>
          </div>
          <p className="text-xs text-red-600/90 mt-0.5">
            Nomor {data.number ? '+' + data.number : ''} tertaut, tapi tak ada detak
            {typeof data.seconds_since === 'number' ? ` sejak ${data.seconds_since} dtk lalu` : ''}.
            Restart service <code className="font-mono px-1 rounded bg-red-100">bukutamu-wa</code> di server.
          </p>
        </div>
        <RefreshCw className={`w-4 h-4 shrink-0 text-red-400 ${isFetching ? 'animate-spin' : ''}`} />
      </div>
    )
  }

  // ── BELUM TERHUBUNG ──
  const digits = pairPhone.replace(/\D/g, '')
  return (
    <div className="admin-card wa-in overflow-hidden">
      {WA_PANEL_STYLE}
      {/* header strip */}
      <div className="px-5 py-3.5 flex items-center justify-between gap-3"
           style={{ background: 'linear-gradient(135deg, var(--admin-primary), color-mix(in srgb, var(--admin-primary) 76%, #000))' }}>
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-white leading-tight">Hubungkan WhatsApp Layanan</h2>
          <p className="text-[11px] text-white/80 leading-tight mt-0.5">Tautkan nomor agar mulai menerima permintaan online</p>
        </div>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/15 text-white text-[11px] font-medium shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-300 animate-pulse" /> Menunggu
        </span>
      </div>

      {/* segmented toggle */}
      <div className="px-5 pt-4">
        <div className="inline-flex p-1 rounded-xl gap-1" style={{ background: 'var(--admin-primary-light)' }}>
          <button onClick={() => setMode('qr')} className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all"
            style={mode === 'qr' ? { background: 'var(--admin-primary)', color: '#fff', boxShadow: '0 2px 8px rgba(196,87,10,.25)' } : { color: 'var(--admin-primary)' }}>
            <QrCode className="w-3.5 h-3.5" /> Pindai QR
          </button>
          <button onClick={() => setMode('phone')} className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all"
            style={mode === 'phone' ? { background: 'var(--admin-primary)', color: '#fff', boxShadow: '0 2px 8px rgba(196,87,10,.25)' } : { color: 'var(--admin-primary)' }}>
            <Smartphone className="w-3.5 h-3.5" /> Nomor HP
          </button>
        </div>
      </div>

      {/* content */}
      <div className="p-5">
        {mode === 'qr' ? (
          <div key="qr" className="wa-in flex flex-col sm:flex-row items-center gap-6">
            <div className="relative shrink-0 rounded-2xl p-3 bg-white" style={{ boxShadow: 'var(--admin-shadow-lg)', border: '1px solid var(--admin-border)' }}>
              {data.qr ? (
                <div className="relative w-[220px] h-[220px] overflow-hidden rounded-lg">
                  <img src={data.qr} alt="QR WhatsApp" className="w-full h-full block" />
                  <div className="wa-scan absolute left-2 right-2 h-[2px] rounded-full"
                       style={{ background: 'linear-gradient(90deg,transparent,var(--admin-primary),transparent)', boxShadow: '0 0 10px var(--admin-primary)' }} />
                  {['top-1 left-1 border-t-2 border-l-2', 'top-1 right-1 border-t-2 border-r-2', 'bottom-1 left-1 border-b-2 border-l-2', 'bottom-1 right-1 border-b-2 border-r-2'].map((c, i) => (
                    <span key={i} className={`absolute w-5 h-5 rounded-[4px] ${c}`} style={{ borderColor: 'var(--admin-primary)' }} />
                  ))}
                </div>
              ) : (
                <div className="w-[220px] h-[220px] grid place-items-center rounded-lg" style={{ background: 'var(--admin-primary-light)' }}>
                  <div className="text-center px-6">
                    <Loader2 className="w-7 h-7 mx-auto animate-spin" style={{ color: 'var(--admin-primary)' }} />
                    <p className="text-xs mt-2" style={{ color: 'var(--admin-text-muted)' }}>Menyiapkan QR…</p>
                  </div>
                </div>
              )}
            </div>
            <div className="space-y-3 min-w-0 text-center sm:text-left">
              <h3 className="text-sm font-bold" style={{ color: 'var(--admin-text)' }}>Pindai dengan WhatsApp</h3>
              <ol className="space-y-2.5 text-left inline-block">
                {['Buka WhatsApp di HP nomor layanan', 'Menu Perangkat Tertaut → Tautkan Perangkat', 'Arahkan kamera ke QR di samping'].map((s, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-sm" style={{ color: 'var(--admin-text-secondary)' }}>
                    <span className="w-5 h-5 rounded-full grid place-items-center text-[11px] font-bold shrink-0 mt-0.5" style={{ background: 'var(--admin-primary-light)', color: 'var(--admin-primary)' }}>{i + 1}</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ol>
              <p className="text-[11px] flex items-center gap-1.5 justify-center sm:justify-start" style={{ color: 'var(--admin-text-muted)' }}>
                <RefreshCw className={`w-3 h-3 ${isFetching ? 'animate-spin' : ''}`} /> QR &amp; status menyegar otomatis
              </p>
            </div>
          </div>
        ) : (
          <div key="phone" className="wa-in max-w-md">
            {data.pairing_code ? (
              <div className="space-y-3">
                <p className="text-xs leading-relaxed" style={{ color: 'var(--admin-text-secondary)' }}>
                  Di WhatsApp: <b>Perangkat Tertaut → Tautkan Perangkat → "Tautkan dengan nomor telepon"</b>, lalu masukkan kode:
                </p>
                <div className="flex items-center justify-center gap-1.5 py-1">
                  {data.pairing_code.split('').map((ch, i) => (
                    <span key={i} className="wa-tile w-9 h-12 grid place-items-center rounded-lg font-mono text-xl font-black"
                      style={{ background: 'var(--admin-primary-light)', color: 'var(--admin-primary)', border: '1.5px solid color-mix(in srgb,var(--admin-primary) 25%,transparent)', animationDelay: `${i * 55}ms` }}>
                      {ch}
                    </span>
                  ))}
                </div>
                <div className="flex items-center justify-between">
                  <button onClick={() => { navigator.clipboard?.writeText(data.pairing_code || ''); toast.success('Kode disalin') }}
                          className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: 'var(--admin-primary)' }}>
                    <Copy className="w-3.5 h-3.5" /> Salin kode
                  </button>
                  <button onClick={() => pair.mutate('')} className="text-xs underline" style={{ color: 'var(--admin-text-muted)' }}>Batal / kembali ke QR</button>
                </div>
                <p className="text-[11px] text-center" style={{ color: 'var(--admin-text-muted)' }}>Kode menyegar otomatis tiap ~3 menit.</p>
              </div>
            ) : data.pair_phone ? (
              <div className="flex flex-col items-center gap-3 py-5">
                <Loader2 className="w-7 h-7 animate-spin" style={{ color: 'var(--admin-primary)' }} />
                <p className="text-sm" style={{ color: 'var(--admin-text-secondary)' }}>Menyiapkan kode untuk <b>{data.pair_phone}</b>…</p>
                <button onClick={() => pair.mutate('')} className="text-xs underline" style={{ color: 'var(--admin-text-muted)' }}>batal</button>
              </div>
            ) : (
              <div className="space-y-2.5">
                <h3 className="text-sm font-bold" style={{ color: 'var(--admin-text)' }}>Tautkan dengan nomor HP</h3>
                <div className="flex gap-2">
                  <div className="flex-1 flex items-center rounded-lg overflow-hidden" style={{ border: '1.5px solid var(--admin-border-strong)', background: 'rgba(255,255,255,0.7)' }}>
                    <span className="pl-3 pr-1 text-sm" style={{ color: 'var(--admin-text-muted)' }}>📱</span>
                    <input value={pairPhone} onChange={(e) => setPairPhone(e.target.value)} placeholder="cth: 081215086262" inputMode="numeric"
                      onKeyDown={(e) => { if (e.key === 'Enter' && digits) pair.mutate(digits) }}
                      className="flex-1 py-2 pr-3 text-sm outline-none bg-transparent" style={{ color: 'var(--admin-text)' }} />
                  </div>
                  <Button size="sm" disabled={pair.isPending || digits === ''} onClick={() => pair.mutate(digits)}>
                    {pair.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Minta Kode <ArrowRight className="w-3.5 h-3.5 ml-1" /></>}
                  </Button>
                </div>
                <p className="text-[11px]" style={{ color: 'var(--admin-text-muted)' }}>Masukkan nomor WhatsApp <b>layanan</b> yang akan ditautkan (bukan nomor petugas).</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default function LayananOnlineInboxPage() {
  // Popup chat aktif (tumpukan; dedupe per nomor).
  const [chats, setChats] = useState<{ phone: string; nama: string | null }[]>([])
  const openChat = (phone: string, nama: string | null) =>
    setChats((cs) => cs.some((c) => c.phone === phone)
      ? cs.map((c) => (c.phone === phone ? { phone, nama } : c)) // segarkan nama bila dibuka ulang
      : [...cs, { phone, nama }])
  const closeChat = (phone: string) => { setChats((cs) => cs.filter((c) => c.phone !== phone)); qc.invalidateQueries({ queryKey: ['wa-inbox'] }) }

  // Hapus entri inbox — HANYA admin/superadmin (bukan petugas PST).
  const { user } = useAuth()
  const qc = useQueryClient()
  const canDelete = user?.role === 'admin' || user?.role === 'superadmin'
  const del = useMutation({
    mutationFn: (r: WaInboxRow) =>
      r.kind === 'pending' ? waApi.deleteSession(r.session_id as number) : visitsApi.delete(r.id_kunjungan as number),
    onSuccess: () => { toast.success('Berhasil dihapus'); qc.invalidateQueries({ queryKey: ['wa-inbox'] }) },
    onError: (e: unknown) => {
      const msg = e && typeof e === 'object' && 'response' in e
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? (e as any).response?.data?.message : null
      toast.error(msg || 'Gagal menghapus')
    },
  })
  function confirmDelete(r: WaInboxRow) {
    const what = r.kind === 'pending'
      ? `sesi "Menunggu Form" dari ${r.notel || 'kontak ini'}`
      : `permintaan WA-${r.id_kunjungan} (${r.nama || 'tanpa nama'}) beserta data & chat-nya`
    if (window.confirm(`⚠️ Hapus ${what}?\n\nTindakan ini PERMANEN dan tidak dapat dibatalkan.`)) del.mutate(r)
  }

  // Popup "Proses" — form konsultasi in-place (backend yang sama, tanpa pindah halaman).
  // Membuka popup otomatis menandai visit 'diproses' (antri/dipanggil → diproses).
  const [prosesId, setProsesId] = useState<number | null>(null)
  const markProses = useMutation({
    mutationFn: (idk: number) => waApi.markProses(idk),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wa-inbox'] }),
  })
  const openProses = (idk: number) => { setProsesId(idk); markProses.mutate(idk) }
  const closeProses = () => { setProsesId(null); qc.invalidateQueries({ queryKey: ['wa-inbox'] }) }

  // Ambil alih (klaim) sebuah sesi/visit; backend kirim "sedang ditangani" ke pengguna.
  const assign = useMutation({
    mutationFn: (sessionId: number) => waApi.assign(sessionId),
    onSuccess: (res) => {
      toast.success(`Diambil alih oleh ${res.data.data?.operator_nama ?? 'Anda'}`)
      qc.invalidateQueries({ queryKey: ['wa-inbox'] })
    },
    onError: (e: unknown) => {
      const msg = e && typeof e === 'object' && 'response' in e
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? (e as any).response?.data?.message : null
      toast.error(msg || 'Gagal mengambil alih')
    },
  })
  // Tutup sesi WA secara manual (muncul setelah pengunjung mengisi evaluasi).
  const selesai = useMutation({
    mutationFn: (idk: number) => waApi.markSelesai(idk),
    onSuccess: () => { toast.success('Sesi ditutup & pesan penutup dikirim'); qc.invalidateQueries({ queryKey: ['wa-inbox'] }) },
    onError: (e: unknown) => {
      const msg = e && typeof e === 'object' && 'response' in e
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? (e as any).response?.data?.message : null
      toast.error(msg || 'Gagal menutup sesi')
    },
  })
  const canReassign = user?.role === 'admin' || user?.role === 'superadmin'

  const { data, isLoading } = useQuery({
    queryKey: ['wa-inbox'],
    queryFn: () => waApi.inbox().then(r => r.data.data),
    refetchInterval: 15000,   // badge pesan belum-dibaca terasa hidup tanpa membuka chat
  })

  const rows: WaInboxRow[] = data ?? []
  const openPhones = new Set(chats.map((c) => c.phone))   // sembunyikan badge utk chat yg sedang dibuka
  const isVisit = (r: WaInboxRow) => r.kind === 'visit'
  const counts = {
    form: rows.filter(r => r.kind === 'pending').length,
    baru: rows.filter(r => isVisit(r) && (r.status === 'antri' || r.status === 'dipanggil')).length,
    diproses: rows.filter(r => isVisit(r) && (r.status === 'proses' || r.status === 'diproses')).length,
    evaluasi: rows.filter(r => isVisit(r) && r.status === 'menunggu_evaluasi').length,
    perluDitutup: rows.filter(r => isVisit(r) && r.status === 'evaluasi_selesai').length,
    selesai: rows.filter(r => isVisit(r) && r.status === 'selesai').length,
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
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatsCard label="Menunggu Form" value={counts.form} icon={<Send className="w-5 h-5" />} accent="primary" />
        <StatsCard label="Baru" value={counts.baru} icon={<Inbox className="w-5 h-5" />} accent="secondary" />
        <StatsCard label="Diproses" value={counts.diproses} icon={<Clock className="w-5 h-5" />} accent="primary" />
        <StatsCard label="Menunggu Evaluasi" value={counts.evaluasi} icon={<Hourglass className="w-5 h-5" />} accent="secondary" />
        <StatsCard label="Perlu Ditutup" value={counts.perluDitutup} icon={<CircleCheck className="w-5 h-5" />} accent="secondary" />
        <StatsCard label="Selesai" value={counts.selesai} icon={<CircleCheck className="w-5 h-5" />} accent="primary" />
      </div>

      {/* Daftar permintaan (termasuk yang belum isi form) */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon="💬" message="Belum ada permintaan online" action="Permintaan dari WhatsApp akan muncul di sini." />
      ) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const pending = r.kind === 'pending'
            return (
              <div key={r.kind + '-' + (r.id_kunjungan ?? r.session_id)} className="admin-card flex items-center gap-4 p-4">
                <div className={`w-12 h-12 rounded-full flex items-center justify-center shrink-0 ${pending ? 'bg-amber-50' : 'bg-emerald-50'}`}>
                  {pending ? <Send className="w-5 h-5 text-amber-600" /> : <MessageSquare className="w-5 h-5 text-emerald-600" />}
                </div>

                <div className="flex-1 min-w-0">
                  {pending ? (
                    <>
                      <p className="font-semibold text-sm truncate" style={{ color: 'var(--admin-text)' }}>{r.nama || 'Belum terdaftar'}</p>
                      <p className="text-xs truncate mt-0.5" style={{ color: 'var(--admin-text-secondary)' }}>Menunggu pengunjung mengisi form · link sudah dikirim</p>
                      <p className="text-[11px] mt-1" style={{ color: 'var(--admin-text-muted)' }}>{r.notel || '—'} · {formatWhen(r.date)}</p>
                    </>
                  ) : (
                    <>
                      <div className="flex items-baseline gap-2 min-w-0">
                        <p className="font-semibold text-sm truncate" style={{ color: 'var(--admin-text)' }}>{r.nama || '(tanpa nama)'}</p>
                        {r.nama_instansi && <span className="text-xs truncate" style={{ color: 'var(--admin-text-muted)' }}>· {r.nama_instansi}</span>}
                      </div>
                      <p className="text-xs truncate mt-0.5" style={{ color: 'var(--admin-text-secondary)' }}>{r.permintaan || 'Permintaan belum dilengkapi'}</p>
                      <p className="text-[11px] mt-1 flex items-center gap-1.5 flex-wrap" style={{ color: 'var(--admin-text-muted)' }}>
                        <span className="font-mono font-medium px-1.5 py-0.5 rounded bg-[var(--admin-primary-light)] text-[var(--admin-primary)]">WA-{r.id_kunjungan}</span>
                        <span>{r.notel || '—'}</span>
                        <span>·</span>
                        <span>{formatWhen(r.date)}</span>
                      </p>
                    </>
                  )}
                </div>

                {pending ? (
                  <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">Menunggu Form</span>
                ) : (
                  <StatusBadge status={r.status} />
                )}

                {r.assigned_to == null ? (
                  <Button size="sm" variant="outline" className="shrink-0"
                    disabled={assign.isPending || r.session_id == null}
                    title="Ambil alih sesi ini" onClick={() => { if (r.session_id != null) assign.mutate(r.session_id) }}>
                    <Hand className="w-3.5 h-3.5 mr-1" /> Ambil alih
                  </Button>
                ) : (
                  <span
                    className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700"
                    style={canReassign ? { cursor: 'pointer' } : undefined}
                    title={canReassign ? 'Pindahkan penanganan ke Anda (admin)' : `Ditangani oleh ${r.operator_nama ?? '-'}`}
                    onClick={() => { if (canReassign && r.session_id != null && window.confirm(`Pindahkan penanganan dari ${r.operator_nama} ke Anda?`)) assign.mutate(r.session_id) }}
                  >
                    <UserCheck className="w-3.5 h-3.5" /> {r.operator_nama ?? 'Ditangani'}
                  </span>
                )}
                {!pending && (
                  <Button size="sm" variant="outline" className="shrink-0" onClick={() => openProses(r.id_kunjungan as number)}>
                    <ExternalLink className="w-3.5 h-3.5 mr-1" /> Proses
                  </Button>
                )}
                {!pending && r.status === 'evaluasi_selesai' && (
                  <Button size="sm" className="shrink-0"
                    disabled={selesai.isPending}
                    title="Tutup sesi & kirim pesan penutup"
                    onClick={() => { if (window.confirm('Tutup sesi ini & kirim pesan penutup ke pengguna?')) selesai.mutate(r.id_kunjungan as number) }}>
                    <CircleCheck className="w-3.5 h-3.5 mr-1" /> Selesai
                  </Button>
                )}
                {r.notel && (
                  <Button size="sm" variant="outline" className="shrink-0 relative" title="Buka chat WhatsApp" onClick={() => openChat(r.notel as string, r.nama)}>
                    <MessageCircle className="w-4 h-4" />
                    {r.unread > 0 && !openPhones.has(r.notel) && (
                      <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 grid place-items-center rounded-full text-[10px] font-bold text-white bg-red-500 shadow-sm">
                        {r.unread > 99 ? '99+' : r.unread}
                      </span>
                    )}
                  </Button>
                )}
                {canDelete && (
                  <Button
                    size="sm" variant="outline"
                    className="shrink-0 text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
                    title="Hapus (admin)" disabled={del.isPending} onClick={() => confirmDelete(r)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Popup chat melayang (bisa digeser/diminimalkan) */}
      {chats.map((c, i) => (
        <ChatPopup key={c.phone} phone={c.phone} nama={c.nama} index={i} onClose={() => closeChat(c.phone)} />
      ))}

      {/* Popup "Proses" — form konsultasi in-place (reuse backend yang sama, tanpa pindah halaman) */}
      <Dialog open={prosesId != null} onOpenChange={(o) => { if (!o) closeProses() }}>
        <DialogContent className="sm:max-w-5xl w-[95vw] max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Proses Permintaan Online</DialogTitle></DialogHeader>
          {prosesId != null && <ConsultationFormPage visitIdProp={prosesId} onClose={closeProses} />}
        </DialogContent>
      </Dialog>
    </div>
  )
}
