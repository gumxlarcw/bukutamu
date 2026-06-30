import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { queueStatsApi } from '@/api/queueStats'
import type { QueueStatsMonthly, QueueStatsQuarterly } from '@/api/queueStats'
import { Skeleton } from '@/components/ui/skeleton'
import { Label } from '@/components/ui/label'
import {
  Timer, Clock, TrendingUp, BarChart3, Activity, CalendarDays,
  Sun, Zap, Sparkles, Users, UserCheck, Repeat, Building2,
  MonitorSmartphone, Pencil, TrendingUp as TrendIcon, CalendarRange,
} from 'lucide-react'
import { parseLayanan, saranaLabel } from '@/types/visit'
import { SARANA_OPTIONS } from '@/types/guest'

function fmt(seconds: number | null | undefined): string {
  if (!seconds) return '-'
  const m = Math.floor(seconds / 60)
  return m > 0 ? `${m} menit` : `${Math.round(seconds)} detik`
}

const BULAN_SHORT = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']
const BULAN_LONG  = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember']
const HARI = ['', 'Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']
const HARI_SHORT = ['', 'Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab']

// Source icons & colors
function sourceMeta(name: string): { icon: typeof MonitorSmartphone; tone: string } {
  if (name === 'Kiosk')             return { icon: MonitorSmartphone, tone: 'bg-emerald-500' }
  if (name === 'Manual (Admin)')    return { icon: Pencil,            tone: 'bg-sky-500' }
  return                                   { icon: Activity,          tone: 'bg-slate-400' }
}

function Bar({ label, value, max, color = 'bg-orange-500', highlight = false }: { label: string; value: number; max: number; color?: string; highlight?: boolean }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div className={`flex items-center gap-2 text-xs ${highlight ? 'font-bold' : ''}`}>
      <span className={`w-20 text-right shrink-0 tabular-nums truncate ${highlight ? 'text-foreground' : 'text-muted-foreground'}`} title={label}>{label}</span>
      <div className="flex-1 h-5 bg-muted/60 rounded overflow-hidden relative">
        <div className={`h-full rounded ${color} flex items-center px-2 transition-all`} style={{ width: `${Math.max(pct, 2)}%` }}>
          {pct > 18 && <span className="text-white text-[10px] font-bold tabular-nums">{value.toLocaleString('id-ID')}</span>}
        </div>
        {highlight && <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[9px] text-foreground/70 font-semibold uppercase tracking-wider pointer-events-none">peak</span>}
      </div>
      {pct <= 18 && <span className="text-muted-foreground w-10 text-right tabular-nums">{value.toLocaleString('id-ID')}</span>}
    </div>
  )
}

function InsightChip({ icon: Icon, label, value, tone = 'orange' }: { icon: typeof Sun; label: string; value: string; tone?: 'orange' | 'blue' | 'green' | 'purple' }) {
  const tones = {
    orange: { iconBg: 'bg-orange-100', iconColor: 'text-orange-600', accent: 'border-l-orange-400' },
    blue:   { iconBg: 'bg-sky-100',    iconColor: 'text-sky-600',    accent: 'border-l-sky-400' },
    green:  { iconBg: 'bg-emerald-100',iconColor: 'text-emerald-600',accent: 'border-l-emerald-400' },
    purple: { iconBg: 'bg-purple-100', iconColor: 'text-purple-600', accent: 'border-l-purple-400' },
  }[tone]
  return (
    <div className={`admin-card p-4 flex items-center gap-3 border-l-4 ${tones.accent}`}>
      <div className={`w-10 h-10 rounded-xl ${tones.iconBg} flex items-center justify-center shrink-0`}>
        <Icon className={`w-5 h-5 ${tones.iconColor}`} />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="text-base font-bold text-foreground truncate">{value}</p>
      </div>
    </div>
  )
}

function KpiCard({ icon: Icon, iconColor, iconBg, value, label, sub }: { icon: typeof Users; iconColor: string; iconBg: string; value: string; label: string; sub?: string }) {
  return (
    <div className="admin-card p-4 flex items-center gap-3">
      <div className={`w-10 h-10 rounded-xl ${iconBg} flex items-center justify-center shrink-0`}>
        <Icon className={`w-5 h-5 ${iconColor}`} />
      </div>
      <div className="min-w-0">
        <p className="text-xl font-bold tabular-nums leading-tight">{value}</p>
        <p className="text-xs text-muted-foreground leading-tight">{label}</p>
        {sub && <p className="text-[10px] text-muted-foreground/70 mt-0.5">{sub}</p>}
      </div>
    </div>
  )
}

/**
 * Combo chart per bulan: batang = jumlah kunjungan, garis = avg durasi (menit) trend.
 * 12 bulan selalu di-render walau sebagian kosong supaya pembaca lihat "lubang" data.
 */
function MonthlyVisitsTrend({ monthly }: { monthly: QueueStatsMonthly[] }) {
  const byBulan = new Map<number, { cnt: number; durSec: number | null }>()
  monthly.forEach(m => byBulan.set(Number(m.bulan), {
    cnt: Number(m.jumlah),
    durSec: m.avg_durasi !== null && m.avg_durasi !== undefined ? Number(m.avg_durasi) : null,
  }))
  const series = Array.from({ length: 12 }, (_, i) => {
    const b = i + 1
    const v = byBulan.get(b)
    return {
      bulan: b,
      cnt: v ? v.cnt : 0,
      durMin: v && v.durSec !== null ? v.durSec / 60 : null,
    }
  })

  const W = 720, H = 240, PAD_L = 36, PAD_R = 44, PAD_T = 24, PAD_B = 36
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B
  const stepX = innerW / 12

  const maxCnt = Math.max(1, ...series.map(s => s.cnt))
  // Y-right (durasi menit): pakai ceil-to-5 supaya skala tidak aneh kalau max=23 jadi label 25
  const validDur = series.filter(s => s.durMin !== null).map(s => s.durMin as number)
  const maxDur = validDur.length === 0 ? 30 : Math.max(...validDur)
  const maxDurNice = Math.max(5, Math.ceil(maxDur / 5) * 5)

  const cntToPx = (c: number) => H - PAD_B - (c / maxCnt) * innerH
  const durToPx = (d: number) => H - PAD_B - (d / maxDurNice) * innerH

  const linePath = series.map((s, i) => {
    const x = PAD_L + stepX * (i + 0.5)
    if (s.durMin === null) return ''
    const y = durToPx(s.durMin)
    return `${i === 0 || series[i - 1]?.durMin === null ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
  }).filter(Boolean).join(' ')

  const totalCnt = series.reduce((a, s) => a + s.cnt, 0)
  const avgDur = validDur.length === 0 ? 0 : validDur.reduce((a, b) => a + b, 0) / validDur.length

  if (totalCnt === 0) {
    return <p className="text-sm text-muted-foreground text-center py-8">Belum ada kunjungan pada periode ini.</p>
  }

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Trend kunjungan dan durasi rata-rata per bulan">
        <defs>
          <linearGradient id="visit-bar-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f97316" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#f97316" stopOpacity="0.35" />
          </linearGradient>
        </defs>

        {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
          const y = PAD_T + innerH * (1 - t)
          return (
            <g key={i}>
              <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke="#e7e5e4" strokeWidth="1" strokeDasharray={i === 0 || i === 4 ? '' : '3 3'} />
              <text x={PAD_L - 6} y={y + 3} fontSize="9" fill="#a8a29e" textAnchor="end" fontWeight="500">{Math.round(maxCnt * t)}</text>
              <text x={W - PAD_R + 6} y={y + 3} fontSize="9" fill="#a8a29e" textAnchor="start" fontWeight="500">{Math.round(maxDurNice * t)}m</text>
            </g>
          )
        })}

        <text x={PAD_L - 6} y={PAD_T - 8} fontSize="9" fill="#f97316" textAnchor="end" fontWeight="700">Kunjungan</text>
        <text x={W - PAD_R + 6} y={PAD_T - 8} fontSize="9" fill="#0ea5e9" textAnchor="start" fontWeight="700">Durasi rata-rata</text>

        {series.map((s, i) => {
          const x = PAD_L + stepX * i + stepX * 0.15
          const barW = stepX * 0.7
          const y = cntToPx(s.cnt)
          const h = H - PAD_B - y
          if (s.cnt === 0) return null
          return (
            <rect key={`bar-${s.bulan}`} x={x} y={y} width={barW} height={Math.max(h, 1)} rx="2" fill="url(#visit-bar-grad)">
              <title>{`${BULAN_LONG[s.bulan]}: ${s.cnt} kunjungan${s.durMin !== null ? `, durasi ~${Math.round(s.durMin)} menit` : ''}`}</title>
            </rect>
          )
        })}

        {linePath && (
          <>
            <path d={linePath} stroke="#0ea5e9" strokeWidth="2.5" fill="none" strokeLinejoin="round" strokeLinecap="round" />
            {series.map((s, i) => {
              if (s.durMin === null) return null
              const x = PAD_L + stepX * (i + 0.5)
              const y = durToPx(s.durMin)
              return (
                <g key={`pt-${s.bulan}`}>
                  <circle cx={x} cy={y} r="4" fill="#0ea5e9" stroke="white" strokeWidth="2" />
                  <title>{`${BULAN_LONG[s.bulan]}: rata-rata ${Math.round(s.durMin)} menit`}</title>
                </g>
              )
            })}
          </>
        )}

        {series.map((s, i) => {
          const x = PAD_L + stepX * (i + 0.5)
          const hasData = s.cnt > 0
          return (
            <text key={`lbl-${s.bulan}`} x={x} y={H - PAD_B + 14} fontSize="10" fill={hasData ? '#44403c' : '#d6d3d1'} textAnchor="middle" fontWeight={hasData ? '600' : '400'}>
              {BULAN_SHORT[s.bulan]}
            </text>
          )
        })}
      </svg>
      <div className="flex items-center justify-between text-xs text-muted-foreground pt-3 mt-3 border-t flex-wrap gap-2">
        <span className="flex items-center gap-2"><span className="inline-block w-3 h-3 rounded bg-orange-400" /> {totalCnt.toLocaleString('id-ID')} kunjungan total</span>
        <span className="flex items-center gap-2"><span className="inline-block w-3 h-0.5 bg-sky-500" /> Durasi rata-rata: <strong className="text-foreground tabular-nums">{avgDur.toFixed(1)} menit</strong></span>
      </div>
    </div>
  )
}

/**
 * Quarterly breakdown: 4 cards (Q1..Q4) dengan jumlah kunjungan + selesai + avg durasi.
 * Tetap render 4 kotak walau tidak ada data, supaya struktur tahunan kelihatan.
 */
function QuarterlyStatsBreakdown({ quarterly }: { quarterly: QueueStatsQuarterly[] }) {
  const byQ = new Map<number, { jml: number; sel: number; dur: number | null }>()
  quarterly.forEach(q => byQ.set(Number(q.triwulan), {
    jml: Number(q.jumlah),
    sel: Number(q.selesai),
    dur: q.avg_durasi !== null && q.avg_durasi !== undefined ? Number(q.avg_durasi) : null,
  }))
  const cards = [1, 2, 3, 4].map(q => {
    const v = byQ.get(q)
    return { q, jml: v?.jml ?? 0, sel: v?.sel ?? 0, dur: v?.dur ?? null }
  })
  const grandMax = Math.max(1, ...cards.map(c => c.jml))

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map(c => {
        const monthRange = c.q === 1 ? 'Jan–Mar' : c.q === 2 ? 'Apr–Jun' : c.q === 3 ? 'Jul–Sep' : 'Okt–Des'
        const hasData = c.jml > 0
        const tone = c.q === 1 ? 'orange' : c.q === 2 ? 'sky' : c.q === 3 ? 'emerald' : 'purple'
        const toneMap = {
          orange:  { bar: 'bg-orange-500',  bg: 'bg-orange-50/50',  text: 'text-orange-700',  ring: 'ring-orange-200' },
          sky:     { bar: 'bg-sky-500',     bg: 'bg-sky-50/50',     text: 'text-sky-700',     ring: 'ring-sky-200' },
          emerald: { bar: 'bg-emerald-500', bg: 'bg-emerald-50/50', text: 'text-emerald-700', ring: 'ring-emerald-200' },
          purple:  { bar: 'bg-purple-500',  bg: 'bg-purple-50/50',  text: 'text-purple-700',  ring: 'ring-purple-200' },
        }[tone]
        const completionPct = c.jml > 0 ? (c.sel / c.jml) * 100 : 0
        const widthPct = hasData ? Math.max((c.jml / grandMax) * 100, 8) : 0
        return (
          <div key={c.q} className={`admin-card p-4 ring-1 ${toneMap.ring} ${hasData ? toneMap.bg : 'bg-slate-50'}`}>
            <div className="flex items-center justify-between mb-1">
              <span className={`text-xs font-bold uppercase tracking-wider ${hasData ? toneMap.text : 'text-slate-400'}`}>Triwulan {c.q}</span>
              <span className="text-[10px] text-muted-foreground">{monthRange}</span>
            </div>
            {hasData ? (
              <>
                <div className="flex items-baseline gap-1 mt-1">
                  <span className="text-2xl font-bold tabular-nums text-foreground">{c.jml.toLocaleString('id-ID')}</span>
                  <span className="text-[10px] text-muted-foreground">kunjungan</span>
                </div>
                <div className={`h-1.5 mt-2 ${toneMap.bar} rounded-full transition-all`} style={{ width: `${widthPct}%` }} />
                <div className="flex items-center justify-between mt-2 text-[11px] text-muted-foreground">
                  <span><strong className="text-foreground tabular-nums">{c.sel.toLocaleString('id-ID')}</strong> selesai ({completionPct.toFixed(0)}%)</span>
                </div>
                {c.dur !== null && <p className="text-[11px] text-muted-foreground mt-0.5">⌀ {Math.round(c.dur / 60)} menit</p>}
              </>
            ) : (
              <>
                <p className="text-sm text-slate-400 italic mt-2">Belum ada data</p>
                <div className="h-1.5 mt-2 bg-slate-100 rounded-full" />
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function QueueStatsPage() {
  const currentYear = new Date().getFullYear().toString()
  const [tahun, setTahun] = useState(currentYear)
  const years = Array.from({ length: 5 }, (_, i) => String(new Date().getFullYear() - i))

  const { data, isLoading } = useQuery({
    queryKey: ['queue-stats', tahun],
    queryFn: () => queueStatsApi.get({ tahun }).then(r => r.data.data),
  })

  // Derived insights & conversion
  const insights = useMemo(() => {
    if (!data) return null
    const peakHour   = (data.hourly  ?? []).reduce<{ jam: number; jumlah: number } | null>((acc, h) => !acc || h.jumlah > acc.jumlah ? h : acc, null)
    const peakDay    = (data.daily   ?? []).reduce<{ hari: string; dow: number; jumlah: number } | null>((acc, d) => !acc || d.jumlah > acc.jumlah ? d : acc, null)
    const peakMonth  = (data.monthly ?? []).reduce<{ bulan: number; jumlah: number } | null>((acc, m) => !acc || m.jumlah > acc.jumlah ? m : acc, null)
    const topService = (data.services ?? [])[0]

    const totalAll  = (data.statuses ?? []).reduce((sum, s) => sum + s.jumlah, 0)
    const totalDone = (data.statuses ?? []).find(s => s.status === 'selesai')?.jumlah ?? 0
    const conversion = totalAll > 0 ? (totalDone / totalAll) * 100 : 0

    const totalSarana = (data.sarana_dist ?? []).reduce((s, x) => s + x.jumlah, 0)
    const totalSource = (data.sources    ?? []).reduce((s, x) => s + x.jumlah, 0)

    const repeatPct = data.distinct_visitors > 0 ? (data.repeat_visitors / data.distinct_visitors) * 100 : 0

    return { peakHour, peakDay, peakMonth, topService, totalAll, totalDone, conversion, totalSarana, totalSource, repeatPct }
  }, [data])

  return (
    <div className="space-y-5">
      <div>
        <h1 className="admin-h1">Analisis Kunjungan &amp; Antrian</h1>
        <p className="admin-subtitle">Pola pengunjung, performa antrian, demografi, dan pemanfaatan kanal layanan</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="qs-tahun">Tahun</Label>
          <select id="qs-tahun" value={tahun} onChange={e => setTahun(e.target.value)} className="h-9 border rounded px-3 text-sm bg-background">
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
      ) : !data ? (
        <div className="text-center py-16 text-muted-foreground border-2 border-dashed rounded-xl">
          <BarChart3 className="w-10 h-10 mx-auto mb-2 opacity-30" />
          <p>Tidak ada data antrian untuk periode ini.</p>
        </div>
      ) : data.total_visits === 0 ? (
        <div className="admin-card p-8 bg-gradient-to-br from-slate-50 to-slate-100/70 ring-1 ring-slate-200 text-center">
          <div className="w-20 h-20 rounded-2xl bg-white shadow-sm flex items-center justify-center mx-auto">
            <Users className="w-10 h-10 text-slate-300" strokeWidth={1.5} />
          </div>
          <h2 className="text-xl font-bold text-slate-700 mt-4">Belum Ada Kunjungan</h2>
          <p className="text-sm text-slate-600 mt-1 max-w-prose mx-auto">
            Tidak ada kunjungan tercatat untuk tahun <strong>{tahun}</strong>. Pilih tahun lain di filter, atau tunggu kunjungan masuk via kiosk maupun manual entry.
          </p>
        </div>
      ) : (
        <>
          {/* ── Insight strip ── */}
          {insights && (insights.peakHour || insights.peakDay || insights.peakMonth || insights.topService) && (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
              {insights.peakHour && <InsightChip icon={Sun} tone="orange" label="Jam Terpadat" value={`${String(insights.peakHour.jam).padStart(2, '0')}:00 — ${insights.peakHour.jumlah.toLocaleString('id-ID')} kunjungan`} />}
              {insights.peakDay && <InsightChip icon={CalendarDays} tone="blue" label="Hari Terpadat" value={`${HARI[insights.peakDay.dow] ?? insights.peakDay.hari} — ${insights.peakDay.jumlah.toLocaleString('id-ID')}`} />}
              {insights.peakMonth && <InsightChip icon={Sparkles} tone="purple" label="Bulan Terpadat" value={`${BULAN_LONG[insights.peakMonth.bulan]} — ${insights.peakMonth.jumlah.toLocaleString('id-ID')}`} />}
              {insights.topService && <InsightChip icon={Zap} tone="green" label="Layanan Terpopuler" value={`${(parseLayanan(insights.topService.jenis_layanan)[0] ?? insights.topService.jenis_layanan)} — ${insights.topService.jumlah.toLocaleString('id-ID')}`} />}
            </div>
          )}

          {/* ── KPI: Visitor cluster (kunjungan-level) ── */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            <KpiCard icon={Users}      iconColor="text-orange-600" iconBg="bg-orange-100" value={data.total_visits.toLocaleString('id-ID')} label="Total Kunjungan" />
            <KpiCard icon={UserCheck}  iconColor="text-sky-600"    iconBg="bg-sky-100"    value={data.distinct_visitors.toLocaleString('id-ID')} label="Pengunjung Unik" sub={`${data.total_visits > 0 ? (data.total_visits / Math.max(1, data.distinct_visitors)).toFixed(1) : '0'}× rata-rata kunjungan/orang`} />
            <KpiCard icon={Repeat}     iconColor="text-purple-600" iconBg="bg-purple-100" value={data.repeat_visitors.toLocaleString('id-ID')} label="Pengunjung Berulang" sub={insights ? `${insights.repeatPct.toFixed(0)}% dari pengunjung unik` : undefined} />
            <KpiCard icon={TrendingUp} iconColor="text-emerald-600" iconBg="bg-emerald-100" value={insights ? `${insights.conversion.toFixed(1)}%` : '-'} label="Conversion Rate" sub={insights ? `${insights.totalDone.toLocaleString('id-ID')} selesai dari ${insights.totalAll.toLocaleString('id-ID')}` : undefined} />
          </div>

          {/* ── KPI: Operational (durasi layanan) ── */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            <KpiCard icon={Timer} iconColor="text-sky-600"      iconBg="bg-sky-100"      value={fmt(data.avg_wait?.avg_durasi)} label="Rata-rata Durasi Layanan" />
            <KpiCard icon={Clock} iconColor="text-emerald-600"  iconBg="bg-emerald-100"  value={fmt(data.avg_wait?.min_durasi)} label="Tercepat" />
            <KpiCard icon={Clock} iconColor="text-red-600"      iconBg="bg-red-100"      value={fmt(data.avg_wait?.max_durasi)} label="Terlama" />
            <KpiCard icon={TrendingUp} iconColor="text-orange-600" iconBg="bg-orange-100" value={(data.avg_wait?.total_selesai ?? 0).toLocaleString('id-ID')} label="Total Selesai (durasi tercatat)" />
          </div>

          {/* ── Triwulan breakdown (Q1..Q4) ── */}
          <div className="admin-card p-5">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <h2 className="text-sm font-bold text-[--admin-text] flex items-center gap-2">
                  <CalendarRange className="w-4 h-4 text-purple-600" />
                  Ringkasan Triwulan
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Kunjungan, conversion, &amp; rata-rata durasi per kuartal — match siklus pelaporan birokrasi
                </p>
              </div>
            </div>
            <QuarterlyStatsBreakdown quarterly={data.quarterly ?? []} />
          </div>

          {/* ── Monthly trend combo chart (kunjungan + durasi) ── */}
          <div className="admin-card p-5">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <h2 className="text-sm font-bold text-[--admin-text] flex items-center gap-2"><TrendIcon className="w-4 h-4 text-orange-600" /> Trend per Bulan</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Batang oranye = jumlah kunjungan &middot; Garis biru = durasi rata-rata (menit) &middot; Tahun {tahun}
                </p>
              </div>
            </div>
            <MonthlyVisitsTrend monthly={data.monthly ?? []} />
          </div>

          {/* ── Conversion funnel ── */}
          {insights && insights.totalAll > 0 && (
            <div className="admin-card p-5">
              <div className="flex items-start justify-between gap-3 mb-4">
                <div>
                  <h2 className="text-sm font-bold text-[--admin-text] flex items-center gap-2">
                    <Activity className="w-4 h-4 text-orange-600" />
                    Status Funnel
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {insights.totalDone.toLocaleString('id-ID')} dari {insights.totalAll.toLocaleString('id-ID')} kunjungan berhasil diselesaikan
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-3xl font-black tabular-nums text-emerald-700">{insights.conversion.toFixed(1)}%</p>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Conversion Rate</p>
                </div>
              </div>
              <div className="space-y-2">
                {(data.statuses ?? []).sort((a, b) => b.jumlah - a.jumlah).map(s => {
                  const max = Math.max(...(data.statuses ?? []).map(x => x.jumlah), 1)
                  const tone = s.status === 'selesai' ? 'bg-emerald-500'
                             : s.status === 'evaluasi_selesai' ? 'bg-teal-500'
                             : s.status === 'menunggu_evaluasi' ? 'bg-sky-500'
                             : s.status === 'proses' || s.status === 'diproses' ? 'bg-amber-500'
                             : s.status === 'antri' ? 'bg-orange-400'
                             : s.status === 'dipanggil' ? 'bg-purple-400'
                             : 'bg-gray-400'
                  return <Bar key={s.status} label={s.status} value={s.jumlah} max={max} color={tone} />
                })}
              </div>
            </div>
          )}

          {/* ── Distribution grid: Jam + Hari ── */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <div className="admin-card p-5">
              <h2 className="text-sm font-bold mb-3 flex items-center gap-2"><Sun className="w-4 h-4 text-orange-600" /> Distribusi per Jam</h2>
              <div className="space-y-1.5">
                {(data.hourly ?? []).map(h => {
                  const max = Math.max(...(data.hourly ?? []).map(x => x.jumlah), 1)
                  const isPeak = insights?.peakHour?.jam === h.jam
                  return <Bar key={h.jam} label={`${String(h.jam).padStart(2, '0')}:00`} value={h.jumlah} max={max} color={isPeak ? 'bg-orange-500' : 'bg-orange-300'} highlight={isPeak} />
                })}
                {(data.hourly ?? []).length === 0 && <p className="text-xs text-muted-foreground">Belum ada data jam.</p>}
              </div>
            </div>

            <div className="admin-card p-5">
              <h2 className="text-sm font-bold mb-3 flex items-center gap-2"><CalendarDays className="w-4 h-4 text-sky-600" /> Distribusi per Hari</h2>
              <div className="space-y-1.5">
                {(data.daily ?? []).map(d => {
                  const max = Math.max(...(data.daily ?? []).map(x => x.jumlah), 1)
                  const isPeak = insights?.peakDay?.dow === d.dow
                  const isWeekend = d.dow === 1 || d.dow === 7
                  const tone = isPeak ? 'bg-sky-600' : isWeekend ? 'bg-sky-200' : 'bg-sky-400'
                  return <Bar key={d.dow} label={HARI_SHORT[d.dow] ?? d.hari} value={d.jumlah} max={max} color={tone} highlight={isPeak} />
                })}
                {(data.daily ?? []).length === 0 && <p className="text-xs text-muted-foreground">Belum ada data harian.</p>}
              </div>
            </div>
          </div>

          {/* ── Distribution grid: Layanan + Sarana ── */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <div className="admin-card p-5">
              <h2 className="text-sm font-bold mb-3 flex items-center gap-2"><Zap className="w-4 h-4 text-emerald-600" /> Distribusi Layanan</h2>
              <div className="space-y-1.5">
                {(data.services ?? []).map((s, idx) => {
                  const max = Math.max(...(data.services ?? []).map(x => x.jumlah), 1)
                  const isTop = idx === 0
                  return <Bar key={s.jenis_layanan} label={parseLayanan(s.jenis_layanan)[0] ?? s.jenis_layanan} value={s.jumlah} max={max} color={isTop ? 'bg-emerald-600' : 'bg-emerald-300'} highlight={isTop} />
                })}
                {(data.services ?? []).length === 0 && <p className="text-xs text-muted-foreground">Belum ada data layanan.</p>}
              </div>
            </div>

            <div className="admin-card p-5">
              <h2 className="text-sm font-bold mb-3 flex items-center gap-2"><MonitorSmartphone className="w-4 h-4 text-purple-600" /> Distribusi Sarana / Kanal</h2>
              {(data.sarana_dist ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">Belum ada data sarana.</p>
              ) : (
                <div className="space-y-1.5">
                  {(data.sarana_dist ?? []).map((s, idx) => {
                    const max = Math.max(...(data.sarana_dist ?? []).map(x => x.jumlah), 1)
                    const isTop = idx === 0
                    // Cari label panjang dari SARANA_OPTIONS, fallback ke saranaLabel helper
                    const opt = SARANA_OPTIONS.find(o => o.value === s.code)
                    const label = opt?.label ?? saranaLabel(s.code) ?? `Kode ${s.code}`
                    return <Bar key={s.code} label={label} value={s.jumlah} max={max} color={isTop ? 'bg-purple-600' : 'bg-purple-300'} highlight={isTop} />
                  })}
                </div>
              )}
            </div>
          </div>

          {/* ── Sumber kunjungan + Top instansi ── */}
          <div className="grid grid-cols-1 xl:grid-cols-[1fr_1.4fr] gap-5">
            <div className="admin-card p-5">
              <h2 className="text-sm font-bold mb-3 flex items-center gap-2"><MonitorSmartphone className="w-4 h-4 text-emerald-600" /> Sumber Kunjungan</h2>
              {(data.sources ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">Tidak ada data sumber.</p>
              ) : (
                <div className="space-y-3">
                  {(data.sources ?? []).map(src => {
                    const totalSrc = insights?.totalSource ?? 0
                    const pct = totalSrc > 0 ? (src.jumlah / totalSrc) * 100 : 0
                    const meta = sourceMeta(src.source)
                    const Icon = meta.icon
                    return (
                      <div key={src.source} className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-2 text-sm font-medium">
                            <Icon className="w-4 h-4 text-muted-foreground" />
                            {src.source}
                          </span>
                          <span className="text-sm font-bold tabular-nums">{src.jumlah.toLocaleString('id-ID')} <span className="text-xs text-muted-foreground font-normal">({pct.toFixed(0)}%)</span></span>
                        </div>
                        <div className="h-2 bg-muted/60 rounded overflow-hidden">
                          <div className={`h-full ${meta.tone} transition-all`} style={{ width: `${Math.max(pct, 1)}%` }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="admin-card p-5">
              <h2 className="text-sm font-bold mb-3 flex items-center gap-2"><Building2 className="w-4 h-4 text-orange-600" /> Top 10 Instansi Pengunjung</h2>
              {(data.top_instansi ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">Belum ada data instansi.</p>
              ) : (
                <div className="space-y-1">
                  {(data.top_instansi ?? []).map((ins, idx) => (
                    <div key={`${ins.nama_instansi}-${idx}`} className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-muted/40 transition-colors">
                      <span className={`w-6 h-6 rounded-md flex items-center justify-center text-[11px] font-bold shrink-0 ${idx < 3 ? 'bg-orange-100 text-orange-700' : 'bg-muted text-muted-foreground'}`}>{idx + 1}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{ins.nama_instansi}</p>
                        {ins.kategori_instansi && <p className="text-[11px] text-muted-foreground truncate">{ins.kategori_instansi}</p>}
                      </div>
                      <span className="text-sm font-bold tabular-nums shrink-0">{ins.jumlah.toLocaleString('id-ID')}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ── Demografi: kategori + gender ── */}
          {((data.kategori_instansi ?? []).length > 0 || (data.gender_dist ?? []).length > 0) && (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
              <div className="admin-card p-5">
                <h2 className="text-sm font-bold mb-3 flex items-center gap-2"><Building2 className="w-4 h-4 text-sky-600" /> Kategori Instansi</h2>
                {(data.kategori_instansi ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">Belum ada data kategori.</p>
                ) : (
                  <div className="space-y-1.5">
                    {(data.kategori_instansi ?? []).map((k, idx) => {
                      const max = Math.max(...(data.kategori_instansi ?? []).map(x => x.jumlah), 1)
                      return <Bar key={k.kategori_instansi} label={k.kategori_instansi} value={k.jumlah} max={max} color={idx === 0 ? 'bg-sky-600' : 'bg-sky-300'} highlight={idx === 0} />
                    })}
                  </div>
                )}
              </div>

              <div className="admin-card p-5">
                <h2 className="text-sm font-bold mb-3 flex items-center gap-2"><Users className="w-4 h-4 text-pink-600" /> Jenis Kelamin Pengunjung Unik</h2>
                {(data.gender_dist ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">Belum ada data jenis kelamin.</p>
                ) : (() => {
                  const total = (data.gender_dist ?? []).reduce((s, g) => s + g.jumlah, 0)
                  return (
                    <div className="space-y-3">
                      {(data.gender_dist ?? []).map(g => {
                        const pct = total > 0 ? (g.jumlah / total) * 100 : 0
                        const isM = g.gender.toLowerCase().startsWith('l') || g.gender.toLowerCase().startsWith('m')
                        const tone = isM ? 'bg-sky-500' : 'bg-pink-500'
                        const label = isM ? 'Laki-laki' : 'Perempuan'
                        return (
                          <div key={g.gender} className="space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-sm font-medium">{label}</span>
                              <span className="text-sm font-bold tabular-nums">{g.jumlah.toLocaleString('id-ID')} <span className="text-xs text-muted-foreground font-normal">({pct.toFixed(0)}%)</span></span>
                            </div>
                            <div className="h-2 bg-muted/60 rounded overflow-hidden">
                              <div className={`h-full ${tone}`} style={{ width: `${Math.max(pct, 1)}%` }} />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}
              </div>
            </div>
          )}

          {/* Tooltip helper note */}
          <p className="text-[11px] text-muted-foreground text-center pt-2">
            Hover di setiap chart untuk lihat detail. Durasi diukur dari kedatangan sampai status selesai.
          </p>
        </>
      )}
    </div>
  )
}
