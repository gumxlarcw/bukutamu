import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { evaluationsApi } from '@/api/evaluations'
import type { EvaluationSummaryVisit, EvaluationSummaryIndicator, EvaluationSummaryMonthly, EvaluationSummaryQuarterly } from '@/api/evaluations'
import { parseLayanan } from '@/types/visit'
import { Skeleton } from '@/components/ui/skeleton'
import { Star, Users, BarChart3, Download, Award, AlertTriangle, Target, Info, TrendingUp, ListChecks, CalendarRange, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { exportCsv } from '@/lib/export-csv'

function formatDate(d: string) {
  try { return new Date(d).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) }
  catch { return d }
}

/**
 * Ambang minimum responden untuk klaim grade IKM. Di bawah threshold,
 * page menampilkan caveat "data masih terbatas" karena 1-2 responden
 * tidak statistically meaningful untuk Indeks Kepuasan Masyarakat.
 */
const MIN_RESPONDEN_GRADE = 10

type IkmInfo =
  | { state: 'graded'; letter: 'A' | 'B' | 'C' | 'D'; label: string; ikm100: number; color: string; bg: string; ring: string }
  | { state: 'insufficient'; ikm100: number; total: number; color: string; bg: string; ring: string }

/**
 * PermenPAN-RB 14/2017 — konversi IKM scale.
 * Skor 1-10 dikonversi ke skala 0-100, lalu di-bin ke 4 grade.
 * Mengembalikan state 'insufficient' jika responden < threshold supaya
 * frontend bisa render caveat alih-alih klaim grade yang lemah.
 */
function ikmGrade(score10: number, totalResponden: number): IkmInfo {
  const ikm100 = (score10 / 10) * 100
  if (totalResponden < MIN_RESPONDEN_GRADE) {
    return { state: 'insufficient', ikm100, total: totalResponden, color: 'text-slate-700', bg: 'bg-slate-50', ring: 'ring-slate-200' }
  }
  if (ikm100 >= 88.31) return { state: 'graded', letter: 'A', label: 'Sangat Baik',  ikm100, color: 'text-emerald-700', bg: 'bg-emerald-50', ring: 'ring-emerald-200' }
  if (ikm100 >= 76.61) return { state: 'graded', letter: 'B', label: 'Baik',         ikm100, color: 'text-sky-700',     bg: 'bg-sky-50',     ring: 'ring-sky-200' }
  if (ikm100 >= 65.00) return { state: 'graded', letter: 'C', label: 'Kurang Baik',  ikm100, color: 'text-amber-700',   bg: 'bg-amber-50',   ring: 'ring-amber-200' }
  return { state: 'graded', letter: 'D', label: 'Tidak Baik', ikm100, color: 'text-red-700', bg: 'bg-red-50', ring: 'ring-red-200' }
}

/* ScoreBar dihapus — diganti oleh IkmPerUnsur yang menampilkan grade per indikator. */

/* IpaQuadrant dihapus: kuesioner BPS terbaru tidak lagi mengukur "kepentingan",
   hanya tingkat kepuasan. IPA Martilla & James butuh dua sumbu — tanpa data
   kepentingan, sumbu X jadi konstan dan visualisasi kehilangan makna.
   Diganti dengan "IKM per Unsur" yang menampilkan skor + grade per indikator. */

/**
 * IKM per Unsur — list tiap indikator dengan IKM 0-100, grade, dan bar visualisasi.
 * Format match dengan format pelaporan SKM PermenPAN-RB 14/2017.
 */
function IkmPerUnsur({ indicators, labels }: { indicators: EvaluationSummaryIndicator[]; labels: Record<string, string> }) {
  if (indicators.length === 0) {
    return <p className="text-sm text-muted-foreground py-8 text-center">Belum ada indikator yang dinilai.</p>
  }
  const sorted = [...indicators].sort((a, b) => Number(b.avg_kepuasan) - Number(a.avg_kepuasan))
  return (
    <div className="space-y-1.5">
      {sorted.map((ind, idx) => {
        const score10 = Number(ind.avg_kepuasan)
        const ikm100 = (score10 / 10) * 100
        const grade = ikm100 >= 88.31 ? { l: 'A', text: 'text-emerald-700', bg: 'bg-emerald-100', bar: 'bg-emerald-500' }
                    : ikm100 >= 76.61 ? { l: 'B', text: 'text-sky-700',     bg: 'bg-sky-100',     bar: 'bg-sky-500' }
                    : ikm100 >= 65.00 ? { l: 'C', text: 'text-amber-700',   bg: 'bg-amber-100',   bar: 'bg-amber-500' }
                    :                   { l: 'D', text: 'text-red-700',     bg: 'bg-red-100',     bar: 'bg-red-500' }
        const label = labels[ind.indikator_id] ?? `Indikator ${ind.indikator_id}`
        return (
          <div key={ind.indikator_id} className="grid grid-cols-[28px_28px_1fr_60px_30px] items-center gap-2 px-2 py-2 rounded hover:bg-muted/40 transition-colors">
            <span className="text-[11px] font-semibold text-muted-foreground tabular-nums text-center">#{idx + 1}</span>
            <span className="text-[10px] font-bold text-muted-foreground tabular-nums bg-muted rounded px-1.5 py-0.5 text-center">{ind.indikator_id}</span>
            <div className="min-w-0">
              <p className="text-xs leading-snug text-foreground line-clamp-2" title={label}>{label}</p>
              <div className="h-1.5 mt-1 bg-muted/60 rounded overflow-hidden">
                <div className={`h-full ${grade.bar} transition-all`} style={{ width: `${Math.max(ikm100, 1.5)}%` }} />
              </div>
            </div>
            <div className="text-right">
              <p className="text-sm font-bold tabular-nums text-foreground">{ikm100.toFixed(1)}</p>
              <p className="text-[9px] text-muted-foreground">{ind.responden} resp.</p>
            </div>
            <span className={`text-xs font-black ${grade.text} ${grade.bg} rounded text-center py-0.5`}>{grade.l}</span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Histogram distribusi rating overall (1-10). Memberi visual cepat:
 * apakah responden polarized (banyak 10 + sedikit 1) atau cluster di tengah.
 */
function RatingDistribution({ visits }: { visits: EvaluationSummaryVisit[] }) {
  const buckets = useMemo(() => {
    const out = new Array(10).fill(0) as number[]
    visits.forEach(v => {
      const r = v.rating_pengunjung
      if (r !== null && r >= 1 && r <= 10) out[Math.round(r) - 1]++
    })
    return out
  }, [visits])
  const total = buckets.reduce((a, b) => a + b, 0)
  const peak = Math.max(...buckets, 1)

  return (
    <div className="flex items-end justify-between gap-1 h-32 px-1">
      {buckets.map((count, i) => {
        const heightPct = Math.max((count / peak) * 100, 2)
        const rating = i + 1
        const tone = rating >= 9 ? 'bg-emerald-500' : rating >= 7 ? 'bg-sky-500' : rating >= 5 ? 'bg-amber-500' : 'bg-red-500'
        const pct = total > 0 ? Math.round((count / total) * 100) : 0
        return (
          <div key={rating} className="flex-1 flex flex-col items-center gap-1 min-w-0 group" title={`Rating ${rating}: ${count} responden (${pct}%)`}>
            <span className="text-[10px] font-semibold text-muted-foreground tabular-nums opacity-0 group-hover:opacity-100 transition-opacity">{count}</span>
            <div className={`w-full rounded-t ${tone} transition-all`} style={{ height: `${heightPct}%` }} />
            <span className="text-[10px] font-medium text-muted-foreground tabular-nums">{rating}</span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Combo chart per bulan: batang = jumlah responden, garis = IKM (skala 0-100).
 * 12 bulan selalu di-render walau sebagian kosong, supaya pembaca melihat "lubang" data —
 * lebih jujur dari hanya menampilkan bulan yang ada datanya.
 */
const BULAN_SHORT_EVAL = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']

function MonthlyTrend({ monthly }: { monthly: EvaluationSummaryMonthly[] }) {
  // Fill 12 bulan: kalau bulan tidak ada datanya, ikm=null & responden=0
  const byBulan = new Map<number, { ikm: number; resp: number }>()
  monthly.forEach(m => byBulan.set(Number(m.bulan), { ikm: Number(m.ikm_score), resp: Number(m.responden) }))
  const series = Array.from({ length: 12 }, (_, i) => {
    const b = i + 1
    const v = byBulan.get(b)
    return { bulan: b, ikm: v ? v.ikm : null, resp: v ? v.resp : 0 }
  })

  const W = 720, H = 240, PAD_L = 36, PAD_R = 36, PAD_T = 24, PAD_B = 36
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B
  const stepX = innerW / 12

  const maxResp = Math.max(1, ...series.map(s => s.resp))
  // Y axis untuk responden (kiri): 0..maxResp; untuk IKM (kanan): 0..100 (skala konversi PermenPAN).
  const respToPx = (r: number) => H - PAD_B - (r / maxResp) * innerH
  const ikmToPx  = (ikm10: number) => H - PAD_B - ((ikm10 / 10) * 100 / 100) * innerH

  // Line path: skip bulan tanpa data dengan move
  const linePath = series.map((s, i) => {
    const x = PAD_L + stepX * (i + 0.5)
    if (s.ikm === null) return ''
    const y = ikmToPx(s.ikm)
    return `${i === 0 || series[i - 1]?.ikm === null ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
  }).filter(Boolean).join(' ')

  const totalResp = series.reduce((a, s) => a + s.resp, 0)
  const avgIkm = (() => {
    const valid = series.filter(s => s.ikm !== null) as { ikm: number }[]
    return valid.length === 0 ? 0 : valid.reduce((a, s) => a + s.ikm, 0) / valid.length
  })()

  if (totalResp === 0) {
    return <p className="text-sm text-muted-foreground text-center py-8">Belum ada data evaluasi pada periode ini.</p>
  }

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Trend IKM dan jumlah responden per bulan">
        <defs>
          <linearGradient id="bar-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0.35" />
          </linearGradient>
        </defs>

        {/* Horizontal gridlines (4 garis) */}
        {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
          const y = PAD_T + innerH * (1 - t)
          return (
            <g key={i}>
              <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke="#e7e5e4" strokeWidth="1" strokeDasharray={i === 0 || i === 4 ? '' : '3 3'} />
              <text x={PAD_L - 6} y={y + 3} fontSize="9" fill="#a8a29e" textAnchor="end" fontWeight="500">
                {Math.round(maxResp * t)}
              </text>
              <text x={W - PAD_R + 6} y={y + 3} fontSize="9" fill="#a8a29e" textAnchor="start" fontWeight="500">
                {Math.round(100 * t)}
              </text>
            </g>
          )
        })}

        {/* Y-axis labels */}
        <text x={PAD_L - 6} y={PAD_T - 8} fontSize="9" fill="#0ea5e9" textAnchor="end" fontWeight="700">Responden</text>
        <text x={W - PAD_R + 6} y={PAD_T - 8} fontSize="9" fill="#c4570a" textAnchor="start" fontWeight="700">IKM (0-100)</text>

        {/* Bars: jumlah responden */}
        {series.map((s, i) => {
          const x = PAD_L + stepX * i + stepX * 0.15
          const barW = stepX * 0.7
          const y = respToPx(s.resp)
          const h = H - PAD_B - y
          if (s.resp === 0) return null
          return (
            <rect key={`bar-${s.bulan}`} x={x} y={y} width={barW} height={Math.max(h, 1)} rx="2" fill="url(#bar-grad)">
              <title>{`${BULAN_SHORT_EVAL[s.bulan]}: ${s.resp} responden${s.ikm !== null ? `, IKM ${(s.ikm / 10 * 100).toFixed(1)}` : ''}`}</title>
            </rect>
          )
        })}

        {/* Line: IKM trend */}
        {linePath && (
          <>
            <path d={linePath} stroke="#c4570a" strokeWidth="2.5" fill="none" strokeLinejoin="round" strokeLinecap="round" />
            {series.map((s, i) => {
              if (s.ikm === null) return null
              const x = PAD_L + stepX * (i + 0.5)
              const y = ikmToPx(s.ikm)
              return (
                <g key={`pt-${s.bulan}`}>
                  <circle cx={x} cy={y} r="4" fill="#c4570a" stroke="white" strokeWidth="2" />
                  <title>{`${BULAN_SHORT_EVAL[s.bulan]}: IKM ${(s.ikm / 10 * 100).toFixed(1)}`}</title>
                </g>
              )
            })}
          </>
        )}

        {/* X-axis: nama bulan */}
        {series.map((s, i) => {
          const x = PAD_L + stepX * (i + 0.5)
          const hasData = s.resp > 0
          return (
            <text key={`lbl-${s.bulan}`} x={x} y={H - PAD_B + 14} fontSize="10" fill={hasData ? '#44403c' : '#d6d3d1'} textAnchor="middle" fontWeight={hasData ? '600' : '400'}>
              {BULAN_SHORT_EVAL[s.bulan]}
            </text>
          )
        })}
      </svg>
      <div className="flex items-center justify-between text-xs text-muted-foreground pt-3 mt-3 border-t">
        <span className="flex items-center gap-2">
          <span className="inline-block w-3 h-3 rounded bg-sky-400" />
          {totalResp} responden total
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block w-3 h-0.5 bg-orange-600" />
          IKM rata-rata: <strong className="text-foreground tabular-nums">{(avgIkm / 10 * 100).toFixed(2)}</strong>
        </span>
      </div>
    </div>
  )
}

/**
 * Quarterly breakdown — 4 cards (Q1..Q4) dengan IKM 0-100 + jumlah responden.
 * Diurutkan Q1 → Q4 (chronological), tidak by performance, supaya pembaca bisa
 * trace trend perjalanan tahun (Q1 → Q4 melihat improvement / decline).
 */
function QuarterlyBreakdown({ quarterly }: { quarterly: EvaluationSummaryQuarterly[] }) {
  const byQ = new Map<number, { ikm: number; resp: number }>()
  quarterly.forEach(q => byQ.set(Number(q.triwulan), { ikm: Number(q.ikm_score), resp: Number(q.responden) }))
  const cards = [1, 2, 3, 4].map(q => {
    const v = byQ.get(q)
    return { q, ikm10: v?.ikm ?? null, resp: v?.resp ?? 0 }
  })

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map(c => {
        const hasData = c.resp > 0 && c.ikm10 !== null
        const ikm100 = hasData ? (Number(c.ikm10) / 10) * 100 : 0
        const grade = !hasData ? { l: '–', text: 'text-slate-400', bg: 'bg-slate-50', ring: 'ring-slate-200' }
                    : ikm100 >= 88.31 ? { l: 'A', text: 'text-emerald-700', bg: 'bg-emerald-50', ring: 'ring-emerald-200' }
                    : ikm100 >= 76.61 ? { l: 'B', text: 'text-sky-700',     bg: 'bg-sky-50',     ring: 'ring-sky-200' }
                    : ikm100 >= 65.00 ? { l: 'C', text: 'text-amber-700',   bg: 'bg-amber-50',   ring: 'ring-amber-200' }
                    :                   { l: 'D', text: 'text-red-700',     bg: 'bg-red-50',     ring: 'ring-red-200' }
        const monthRange = c.q === 1 ? 'Jan–Mar' : c.q === 2 ? 'Apr–Jun' : c.q === 3 ? 'Jul–Sep' : 'Okt–Des'
        return (
          <div key={c.q} className={`admin-card p-4 ring-1 ${grade.ring} ${grade.bg}`}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Triwulan {c.q}</span>
              <span className={`text-xl font-black ${grade.text} leading-none`}>{grade.l}</span>
            </div>
            <p className="text-[10px] text-muted-foreground mb-2">{monthRange}</p>
            {hasData ? (
              <>
                <div className="flex items-baseline gap-1">
                  <span className="text-2xl font-bold tabular-nums text-foreground">{ikm100.toFixed(1)}</span>
                  <span className="text-[10px] text-muted-foreground">/ 100</span>
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">{c.resp} responden</p>
              </>
            ) : (
              <p className="text-xs text-slate-500 italic">Belum ada data</p>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function EvaluationSummaryPage() {
  const currentYear = new Date().getFullYear().toString()
  const [tahun, setTahun] = useState(currentYear)

  const { data, isLoading } = useQuery({
    queryKey: ['evaluation-summary', tahun],
    queryFn: () => evaluationsApi.getSummary({ tahun: tahun || undefined }).then(r => r.data.data),
  })

  // Which per-visit cards are expanded to reveal their per-data-item quality (kualitas).
  const [expandedVisits, setExpandedVisits] = useState<Set<number>>(new Set())
  const toggleVisit = (id: number) => setExpandedVisits(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const years = Array.from({ length: 5 }, (_, i) => String(new Date().getFullYear() - i))

  // Compute best & worst indicator dengan label naratif untuk highlight cards.
  const bestWorst = useMemo(() => {
    if (!data || data.indicators.length === 0) return null
    const sorted = [...data.indicators].sort((a, b) => Number(b.avg_kepuasan) - Number(a.avg_kepuasan))
    const best  = sorted[0]
    const worst = sorted[sorted.length - 1]
    return {
      best:  { ind: best,  label: data.labels[best.indikator_id]  ?? `Indikator ${best.indikator_id}` },
      worst: { ind: worst, label: data.labels[worst.indikator_id] ?? `Indikator ${worst.indikator_id}` },
    }
  }, [data])

  return (
    <div className="space-y-5">
      <div>
        <h1 className="admin-h1">Hasil Evaluasi Layanan</h1>
        <p className="admin-subtitle">Indeks Kepuasan Masyarakat (IKM) sesuai PermenPAN-RB 14/2017</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="eval-tahun">Tahun</Label>
          <select id="eval-tahun" value={tahun} onChange={e => setTahun(e.target.value)} className="h-9 border rounded px-3 text-sm bg-background">
            <option value="">Semua Tahun</option>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        {data && Number(data.overall.total_responden) > 0 && (
          <Button variant="outline" size="sm" onClick={() => {
            exportCsv('evaluasi-ikm', data.indicators.map(ind => ({
              indikator_id: ind.indikator_id,
              indikator: data.labels[ind.indikator_id] ?? `Indikator ${ind.indikator_id}`,
              avg_kepentingan: Number(ind.avg_kepentingan).toFixed(2),
              avg_kepuasan: Number(ind.avg_kepuasan).toFixed(2),
              responden: ind.responden,
            })))
          }}>
            <Download className="w-4 h-4 mr-2" />
            Export CSV
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_1fr] gap-5">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : !data || !data.overall || Number(data.overall.total_responden) === 0 ? (
        // ── Hero "Belum Dievaluasi" — friendly card, BUKAN grade D ──
        <div className="admin-card p-8 bg-gradient-to-br from-slate-50 to-slate-100/70 ring-1 ring-slate-200">
          <div className="flex flex-col md:flex-row items-center gap-6">
            <div className="w-24 h-24 rounded-2xl bg-white shadow-sm flex items-center justify-center shrink-0">
              <Star className="w-12 h-12 text-slate-300" strokeWidth={1.5} />
            </div>
            <div className="text-center md:text-left flex-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Indeks Kepuasan Masyarakat</p>
              <h2 className="text-2xl font-bold text-slate-700 mt-1">Belum Ada Evaluasi</h2>
              <p className="text-sm text-slate-600 mt-2 leading-relaxed max-w-prose">
                Belum ada responden yang mengisi form evaluasi untuk tahun <strong>{tahun || 'semua periode'}</strong>.
                IKM akan terhitung otomatis setelah tamu menyelesaikan kunjungan dan mengisi evaluasi via tablet.
              </p>
              <div className="flex flex-wrap items-center justify-center md:justify-start gap-3 mt-4 text-xs text-slate-500">
                <span className="flex items-center gap-1.5"><Info className="w-3.5 h-3.5" /> Evaluasi hanya untuk layanan SKD (4 inti)</span>
                <span className="flex items-center gap-1.5"><Target className="w-3.5 h-3.5" /> Min. {MIN_RESPONDEN_GRADE} responden untuk grade IKM</span>
              </div>
            </div>
          </div>
        </div>
      ) : (() => {
        const ikm = ikmGrade(Number(data.overall.ikm_score), Number(data.overall.total_responden))
        return (
          <>
            {/* ── HERO: IKM Grade big card + KPI cluster ── */}
            <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_2fr] gap-4">
              {/* Big grade card (state: graded | insufficient) */}
              <div className={`admin-card p-6 ${ikm.bg} ring-1 ${ikm.ring} flex items-center gap-5`}>
                <div className={`w-24 h-24 rounded-2xl bg-white shadow-sm flex items-center justify-center ${ikm.color}`}>
                  {ikm.state === 'graded' ? (
                    <span className="text-6xl font-black leading-none">{ikm.letter}</span>
                  ) : (
                    <Info className="w-12 h-12" strokeWidth={1.5} />
                  )}
                </div>
                <div className="min-w-0">
                  <p className={`text-xs font-semibold uppercase tracking-wider ${ikm.color}`}>Mutu Pelayanan</p>
                  {ikm.state === 'graded' ? (
                    <>
                      <p className="text-2xl font-bold text-foreground leading-tight mt-0.5">{ikm.label}</p>
                      <div className="flex items-baseline gap-3 mt-2">
                        <span className="text-xs text-muted-foreground">IKM</span>
                        <span className="text-2xl font-bold tabular-nums text-foreground">{ikm.ikm100.toFixed(2)}</span>
                        <span className="text-xs text-muted-foreground">/ 100</span>
                        <span className="text-xs text-muted-foreground ml-2">({Number(data.overall.ikm_score).toFixed(2)} dari 10)</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="text-2xl font-bold text-foreground leading-tight mt-0.5">Data Masih Terbatas</p>
                      <p className="text-xs text-slate-600 mt-1 leading-snug">
                        Baru <strong>{ikm.total}</strong> responden — minimum {MIN_RESPONDEN_GRADE} untuk grade IKM yang reliable.
                      </p>
                      <div className="flex items-baseline gap-3 mt-2">
                        <span className="text-xs text-muted-foreground">Skor sementara</span>
                        <span className="text-xl font-bold tabular-nums text-slate-700">{ikm.ikm100.toFixed(2)}</span>
                        <span className="text-xs text-muted-foreground">/ 100</span>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* KPI cluster */}
              <div className="grid grid-cols-3 gap-3">
                <div className="admin-card p-4 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-sky-100 flex items-center justify-center shrink-0">
                    <Users className="w-5 h-5 text-sky-600" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-2xl font-bold tabular-nums">{data.overall.total_responden}</p>
                    <p className="text-xs text-muted-foreground">Total Responden</p>
                  </div>
                </div>
                <div className="admin-card p-4 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center shrink-0">
                    <Target className="w-5 h-5 text-amber-600" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-2xl font-bold tabular-nums">{data.indicators.length}</p>
                    <p className="text-xs text-muted-foreground">Indikator Dinilai</p>
                  </div>
                </div>
                <div className="admin-card p-4 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center shrink-0">
                    <BarChart3 className="w-5 h-5 text-purple-600" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-2xl font-bold tabular-nums">{data.visits.length}</p>
                    <p className="text-xs text-muted-foreground">Kunjungan Terevaluasi</p>
                  </div>
                </div>
                {bestWorst && (
                  <>
                    <div className="admin-card p-4 col-span-3 flex items-center gap-3 bg-emerald-50/40">
                      <div className="w-10 h-10 rounded-xl bg-emerald-100 flex items-center justify-center shrink-0">
                        <Award className="w-5 h-5 text-emerald-600" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700">Indikator Tertinggi</p>
                        <p className="text-sm font-medium text-foreground truncate">{bestWorst.best.label}</p>
                      </div>
                      <p className="text-2xl font-bold tabular-nums text-emerald-700">{Number(bestWorst.best.ind.avg_kepuasan).toFixed(2)}</p>
                    </div>
                    <div className="admin-card p-4 col-span-3 flex items-center gap-3 bg-red-50/40">
                      <div className="w-10 h-10 rounded-xl bg-red-100 flex items-center justify-center shrink-0">
                        <AlertTriangle className="w-5 h-5 text-red-600" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-red-700">Perlu Perbaikan</p>
                        <p className="text-sm font-medium text-foreground truncate">{bestWorst.worst.label}</p>
                      </div>
                      <p className="text-2xl font-bold tabular-nums text-red-700">{Number(bestWorst.worst.ind.avg_kepuasan).toFixed(2)}</p>
                    </div>
                  </>
                )}
              </div>
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
                    IKM &amp; jumlah responden per kuartal — match siklus pelaporan birokrasi
                  </p>
                </div>
              </div>
              <QuarterlyBreakdown quarterly={data.quarterly ?? []} />
            </div>

            {/* ── IKM per Unsur (16 indikator) + Rating Distribution ── */}
            <div className="grid grid-cols-1 xl:grid-cols-[1.6fr_1fr] gap-5">
              <div className="admin-card p-5">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <h2 className="text-sm font-bold text-[--admin-text] flex items-center gap-2">
                      <ListChecks className="w-4 h-4 text-orange-600" />
                      IKM per Unsur
                    </h2>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Skala 0–100 sesuai PermenPAN-RB 14/2017. Diurutkan dari tertinggi ke terendah.
                    </p>
                  </div>
                  <span className="text-[10px] text-muted-foreground bg-muted px-2 py-1 rounded-full flex items-center gap-1 shrink-0">
                    <Info className="w-3 h-3" />
                    Hover untuk teks penuh
                  </span>
                </div>
                <IkmPerUnsur indicators={data.indicators} labels={data.labels} />
                <div className="flex items-center justify-end gap-3 text-[11px] text-muted-foreground pt-3 mt-3 border-t flex-wrap">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500" /> D &lt;65</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-500" /> C 65–76</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-sky-500" /> B 76–88</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500" /> A ≥88</span>
                </div>
              </div>

              <div className="admin-card p-5 space-y-3">
                <div>
                  <h2 className="text-sm font-bold text-[--admin-text]">Distribusi Rating Keseluruhan</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">Skor 1–10 yang diberikan responden</p>
                </div>
                <RatingDistribution visits={data.visits} />
                <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-2 border-t">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500" /> 1-4 buruk</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-500" /> 5-6 cukup</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-sky-500" /> 7-8 baik</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500" /> 9-10 sgt baik</span>
                </div>
              </div>
            </div>

            {/* ── Monthly Trend (IKM + responden) ── */}
            <div className="admin-card p-5">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <h2 className="text-sm font-bold text-[--admin-text] flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-orange-600" />
                    Trend per Bulan
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Garis oranye = IKM (0-100) &middot; Batang biru = jumlah responden &middot; Tahun {tahun || 'semua'}
                  </p>
                </div>
              </div>
              <MonthlyTrend monthly={data.monthly ?? []} />
            </div>

            {/* ── Per-visit list (full width) ── */}
            <div className="grid grid-cols-1 gap-5">
              <div className="admin-card p-5">
                <div className="flex items-center justify-between mb-4 gap-3">
                  <div>
                    <h2 className="text-sm font-bold text-[--admin-text]">Evaluasi per Kunjungan</h2>
                    <p className="text-xs text-muted-foreground mt-0.5">{data.visits.length} responden tahun {tahun || 'semua'}</p>
                  </div>
                </div>
                {data.visits.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Belum ada evaluasi.</p>
                ) : (
                  <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                    {data.visits.map((v: EvaluationSummaryVisit) => {
                      const rating = v.rating_pengunjung
                      const tone = rating === null ? 'bg-muted text-muted-foreground' :
                                   rating >= 9 ? 'bg-emerald-100 text-emerald-700' :
                                   rating >= 7 ? 'bg-sky-100 text-sky-700' :
                                   rating >= 5 ? 'bg-amber-100 text-amber-700' :
                                                 'bg-red-100 text-red-700'
                      const vid = Number(v.id_kunjungan)
                      const items = v.items ?? []
                      const hasItems = items.length > 0
                      const isOpen = expandedVisits.has(vid)
                      return (
                        <div key={v.id_kunjungan} className="rounded-lg border hover:bg-muted/30 transition-colors">
                          <div
                            className={`flex items-center gap-3 p-3 ${hasItems ? 'cursor-pointer' : ''}`}
                            onClick={hasItems ? () => toggleVisit(vid) : undefined}
                            role={hasItems ? 'button' : undefined}
                            tabIndex={hasItems ? 0 : undefined}
                            aria-expanded={hasItems ? isOpen : undefined}
                            onKeyDown={hasItems ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleVisit(vid) } } : undefined}
                          >
                            <div className={`w-10 h-10 rounded-full ${tone} flex items-center justify-center shrink-0`}>
                              <span className="text-sm font-bold tabular-nums">{rating ?? '-'}</span>
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{v.nama}</p>
                              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                {parseLayanan(v.jenis_layanan).map((l, i) => (
                                  <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">{l}</span>
                                ))}
                                <span className="text-[11px] text-muted-foreground">{formatDate(v.date_visit)}</span>
                                {hasItems && (
                                  <span className="text-[11px] text-muted-foreground">· {items.length} data dinilai</span>
                                )}
                              </div>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="text-[10px] text-muted-foreground">Kepuasan</p>
                              <p className="text-sm font-bold tabular-nums">{Number(v.avg_kepuasan).toFixed(2)}</p>
                            </div>
                            {hasItems && (
                              <ChevronDown className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                            )}
                          </div>
                          {hasItems && isOpen && (
                            <div className="border-t bg-muted/20 px-3 py-2 space-y-1.5">
                              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Kualitas Data Diterima</p>
                              {items.map((it) => {
                                const q = it.kualitas === null || it.kualitas === undefined ? null : Number(it.kualitas)
                                const sesuai = Number(it.status_data) === 1
                                return (
                                  <div key={it.id} className="flex items-center gap-2">
                                    <span className={`text-[9px] px-1.5 py-0.5 rounded shrink-0 ${sesuai ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                                      {sesuai ? 'sesuai' : 'tidak sesuai'}
                                    </span>
                                    <span className="text-xs text-foreground flex-1 min-w-0 truncate" title={it.rincian_data}>{it.rincian_data}</span>
                                    {q === null ? (
                                      <span className="text-[11px] text-muted-foreground italic shrink-0">belum dinilai</span>
                                    ) : (
                                      <span className="text-xs font-bold tabular-nums shrink-0 flex items-center gap-0.5">
                                        <Star className="w-3 h-3 text-amber-500 fill-amber-500" />{q}
                                      </span>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </>
        )
      })()}
    </div>
  )
}
