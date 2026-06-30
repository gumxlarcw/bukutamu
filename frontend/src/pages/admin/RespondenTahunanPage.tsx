import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { parseLayanan, parseSarana, saranaLabel, LEVEL_DATA_OPTIONS, PERIODE_DATA_OPTIONS, STATUS_DATA_OPTIONS } from '@/types/visit'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Search, ChevronLeft, ChevronRight, Download, Users, ClipboardCheck, Eye, Clock } from 'lucide-react'
import {
  PENDIDIKAN_OPTIONS,
  UMUR_OPTIONS,
  DISABILITAS_OPTIONS,
  JENIS_DISABILITAS_OPTIONS,
  PEKERJAAN_OPTIONS,
  KATEGORI_INSTANSI_OPTIONS,
  PEMANFAATAN_OPTIONS,
} from '@/types/guest'
import { guestsApi, type GuestVisit } from '@/api/guests'
import { respondenApi, type RespondenRow } from '@/api/responden'
import { evaluationsApi } from '@/api/evaluations'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { exportCsv } from '@/lib/export-csv'

const TW_LABELS: Record<string, string> = { '1': 'TW I (Jan–Mar)', '2': 'TW II (Apr–Jun)', '3': 'TW III (Jul–Sep)', '4': 'TW IV (Okt–Des)' }

// 4 core SKD services that make a respondent eligible for SKD/SKM evaluation.
const SKD_SERVICES = [
  'Perpustakaan',
  'Konsultasi Statistik',
  'Rekomendasi Kegiatan Statistik',
  'Penjualan Produk Statistik',
] as const

function isSkdEligible(jenis_layanan: string | null): boolean {
  const services = parseLayanan(jenis_layanan)
  return services.some(s => (SKD_SERVICES as readonly string[]).includes(s))
}

function formatDate(d: string) {
  try { return new Date(d).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) }
  catch { return d }
}

/** Score badge: green >=8, yellow 5-7, red <=4 */
function ScoreBadge({ score }: { score: number }) {
  const color =
    score >= 8 ? 'bg-green-100 text-green-700' :
    score >= 5 ? 'bg-yellow-100 text-yellow-700' :
    'bg-red-100 text-red-700'
  return (
    <span className={`inline-flex items-center justify-center w-8 h-6 rounded text-xs font-bold shrink-0 ${color}`}>
      {score}
    </span>
  )
}

/**
 * One visit row in the history list. Visits that were actually evaluated
 * (rating_pengunjung set) get an explicit "Lihat Evaluasi" button; clicking it
 * reveals that visit's full 16-indicator kepuasan scores. Visits without an
 * evaluation show no button. Each row owns its own react-query fetch keyed by
 * id_kunjungan, so results are cached per visit and only fetched once viewed.
 */
function VisitHistoryRow({ visit }: { visit: GuestVisit }) {
  const [expanded, setExpanded] = useState(false)
  const isEvaluated = visit.rating_pengunjung !== null

  const { data: evalDetail, isLoading } = useQuery({
    queryKey: ['eval-results-responden', visit.id_kunjungan],
    queryFn: () => evaluationsApi.getResults(visit.id_kunjungan).then(r => r.data.data),
    enabled: expanded && isEvaluated,
  })

  const isDone = visit.status === 'selesai' || visit.status === 'evaluasi_selesai'

  return (
    <div className="rounded-lg bg-muted/40 overflow-hidden">
      <div className="flex items-center gap-2 text-xs p-2">
        <span className="text-muted-foreground shrink-0">
          {new Date(visit.date_visit).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })}
        </span>
        <div className="flex flex-wrap gap-1 flex-1 min-w-0">
          {parseLayanan(visit.jenis_layanan).map((l, i) => (
            <span key={i} className="px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 text-[10px]">{l}</span>
          ))}
        </div>
        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${isDone ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
          {visit.status}
        </span>
        {isEvaluated && (
          <>
            <span className="text-amber-600 font-bold shrink-0">
              {'★'}{visit.rating_pengunjung}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 shrink-0"
              onClick={() => setExpanded(e => !e)}
            >
              <Eye className="w-3.5 h-3.5 mr-1" />
              {expanded ? 'Tutup' : 'Lihat Evaluasi'}
            </Button>
          </>
        )}
      </div>

      {expanded && isEvaluated && (
        <div className="px-2 pb-2 border-t">
          {isLoading ? (
            <div className="space-y-1.5 pt-2">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-6 rounded" />)}
            </div>
          ) : evalDetail && evalDetail.details && evalDetail.details.length > 0 ? (
            <>
              <p className="text-[11px] text-muted-foreground pt-2 mb-1">
                Rating keseluruhan: <strong>{evalDetail.rating_pengunjung ?? '-'}/10</strong>
                {evalDetail.durasi_detik != null && ` · Durasi ${Math.round(evalDetail.durasi_detik / 60)} mnt`}
              </p>
              <div className="space-y-0.5">
                {evalDetail.details
                  .slice()
                  .sort((a, b) => a.indikator_id - b.indikator_id)
                  .map(detail => {
                    const label = evalDetail.indikator?.[String(detail.indikator_id)] ?? `Indikator ${detail.indikator_id}`
                    return (
                      <div key={detail.id} className="flex items-start gap-2 text-[11px] py-0.5">
                        <span className="text-muted-foreground shrink-0 w-5 text-right pt-0.5">{detail.indikator_id}.</span>
                        <span className="flex-1 text-muted-foreground leading-relaxed" title={label}>{label}</span>
                        <ScoreBadge score={Number(detail.kepuasan)} />
                      </div>
                    )
                  })}
              </div>
            </>
          ) : (
            <p className="text-[11px] text-muted-foreground italic pt-2">Rincian indikator tidak tersedia untuk kunjungan ini.</p>
          )}
        </div>
      )}
    </div>
  )
}

export default function RespondenTahunanPage() {
  const currentYear = new Date().getFullYear().toString()
  const [tahun, setTahun] = useState(currentYear)
  const [triwulan, setTriwulan] = useState('')
  const [skdFilter, setSkdFilter] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(10)
  const [viewRow, setViewRow] = useState<RespondenRow | null>(null)

  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput); setPage(1) }, 400)
    return () => clearTimeout(t)
  }, [searchInput])

  const { data: viewProfile } = useQuery({
    queryKey: ['guest-profile', viewRow?.id_user],
    queryFn: () => guestsApi.get(viewRow!.id_user).then(r => r.data.data),
    enabled: !!viewRow,
  })

  const { data: viewVisits } = useQuery({
    queryKey: ['guest-visits-responden', viewRow?.id_user],
    queryFn: () => guestsApi.getVisits(viewRow!.id_user).then(r => r.data.data),
    enabled: !!viewRow,
  })

  // Count of evaluated visits (rating_pengunjung set) — surfaced as a header note
  // so the user knows how many of the visit-history rows are expandable.
  const evaluatedVisitCount = viewVisits
    ? viewVisits.filter((v: GuestVisit) => v.rating_pengunjung !== null).length
    : 0

  const { data, isLoading } = useQuery({
    queryKey: ['responden-tahunan', { tahun, triwulan, skd: skdFilter, q: search, page, limit }],
    queryFn: () => respondenApi.list({
      tahun,
      q: search || undefined,
      page,
      limit,
      triwulan: triwulan || undefined,
      ...(skdFilter ? { skd: '1' } : {}),
    }).then(r => r.data),
  })

  const rows: RespondenRow[] = data?.data ?? []
  const pagination = data?.pagination
  const summary = data?.summary
  const years = Array.from({ length: 5 }, (_, i) => String(new Date().getFullYear() - i))

  // Export one row PER VISIT (per kunjungan) — a person with 2 evaluated visits at different
  // times appears twice. Each row carries the visit date + the per-indikator kepuasan scores.
  const handleExport = () => {
    respondenApi.exportVisits({ tahun, triwulan: triwulan || undefined }).then(r => {
      const { visits, indikator_labels } = r.data.data
      const indIds = Object.keys(indikator_labels).map(Number).sort((a, b) => a - b)
      const rows = visits.map((v) => {
        const ks = v.konsultasi ?? []
        const base: Record<string, unknown> = {
          id_kunjungan: v.id_kunjungan,
          id_user: v.id_user,
          tanggal: v.date_visit,
          tgl_registrasi: v.tgldatang ?? '',
          nomor_antrian: v.nomor_antrian ?? '',
          nama: v.nama,
          nama_instansi: v.nama_instansi ?? '',
          email: v.email ?? '',
          telepon: v.notel ?? '',
          jenis_kelamin: v.jeniskelamin ?? '',
          umur: UMUR_OPTIONS.find(o => o.value === Number(v.umur))?.label ?? '',
          pendidikan: PENDIDIKAN_OPTIONS.find(o => o.value === Number(v.pendidikan))?.label ?? '',
          pekerjaan: PEKERJAAN_OPTIONS.find(o => o.value === Number(v.pekerjaan))?.label ?? '',
          pekerjaan_lainnya: v.pekerjaan_lainnya ?? '',
          kategori_instansi: KATEGORI_INSTANSI_OPTIONS.find(o => o.value === Number(v.kategori_instansi))?.label ?? '',
          kategori_lainnya: v.kategori_lainnya ?? '',
          pemanfaatan: PEMANFAATAN_OPTIONS.find(o => o.value === Number(v.pemanfaatan))?.label ?? '',
          pemanfaatan_lainnya: v.pemanfaatan_lainnya ?? '',
          disabilitas: DISABILITAS_OPTIONS.find(o => o.value === Number(v.disabilitas))?.label ?? '',
          jenis_disabilitas: Number(v.disabilitas) === 1 ? (JENIS_DISABILITAS_OPTIONS.find(o => o.value === Number(v.jenis_disabilitas))?.label ?? '') : '',
          layanan: parseLayanan(v.jenis_layanan).join('; '),
          layanan_lainnya: v.layanan_lainnya ?? '',
          sarana: parseSarana(v.sarana).map(saranaLabel).join('; '),
          sarana_lainnya: v.sarana_lainnya ?? '',
          rincian_data: ks.map(k => k.rincian_data ?? '').join(' || '),
          wilayah_data: ks.map(k => k.wilayah_data ?? '').join(' || '),
          tahun_data: ks.map(k => k.tahun_awal ? (String(k.tahun_awal) === String(k.tahun_akhir) ? String(k.tahun_awal) : `${k.tahun_awal}-${k.tahun_akhir}`) : '').join(' || '),
          level_data: ks.map(k => LEVEL_DATA_OPTIONS.find(o => o.value === Number(k.level_data))?.label ?? '').join(' || '),
          periode_data: ks.map(k => PERIODE_DATA_OPTIONS.find(o => o.value === Number(k.periode_data))?.label ?? '').join(' || '),
          status_data: ks.map(k => STATUS_DATA_OPTIONS.find(o => o.value === Number(k.status_data))?.label ?? '').join(' || '),
          kode_bidang: ks.map(k => k.kode_bidang_statistik ?? '').join(' || '),
          digunakan_nasional: ks.map(k => (k.digunakan_nasional == null || k.digunakan_nasional === '') ? '' : (Number(k.digunakan_nasional) === 1 ? 'Ya' : 'Tidak')).join(' || '),
          kualitas: ks.map(k => k.kualitas ?? '').join(' || '),
          hasil_konsultasi: v.hasil_konsultasi ?? '',
          durasi_detik: v.durasi_detik ?? '',
          rating: v.rating_pengunjung ?? '',
          pengaduan: v.pengaduan ?? '',
        }
        indIds.forEach((id) => { base[`ind_${id}`] = v.indikator?.[String(id)] ?? '' })
        return base
      })
      const cols = [
        { key: 'id_kunjungan', label: 'ID Kunjungan' },
        { key: 'id_user', label: 'ID Responden' },
        { key: 'tanggal', label: 'Tanggal Kunjungan' },
        { key: 'tgl_registrasi', label: 'Tanggal Registrasi' },
        { key: 'nomor_antrian', label: 'No. Antrian' },
        { key: 'nama', label: 'Nama' },
        { key: 'nama_instansi', label: 'Instansi' },
        { key: 'email', label: 'Email' },
        { key: 'telepon', label: 'Telepon' },
        { key: 'jenis_kelamin', label: 'Jenis Kelamin' },
        { key: 'umur', label: 'Umur' },
        { key: 'pendidikan', label: 'Pendidikan' },
        { key: 'pekerjaan', label: 'Pekerjaan' },
        { key: 'pekerjaan_lainnya', label: 'Pekerjaan Lainnya' },
        { key: 'kategori_instansi', label: 'Kategori Instansi' },
        { key: 'kategori_lainnya', label: 'Kategori Lainnya' },
        { key: 'pemanfaatan', label: 'Pemanfaatan' },
        { key: 'pemanfaatan_lainnya', label: 'Pemanfaatan Lainnya' },
        { key: 'disabilitas', label: 'Disabilitas' },
        { key: 'jenis_disabilitas', label: 'Jenis Disabilitas' },
        { key: 'layanan', label: 'Layanan' },
        { key: 'layanan_lainnya', label: 'Layanan Lainnya' },
        { key: 'sarana', label: 'Sarana' },
        { key: 'sarana_lainnya', label: 'Sarana Lainnya' },
        { key: 'rincian_data', label: 'Rincian Data Diminta' },
        { key: 'wilayah_data', label: 'Wilayah Data' },
        { key: 'tahun_data', label: 'Tahun Data' },
        { key: 'level_data', label: 'Level Data' },
        { key: 'periode_data', label: 'Periode Data' },
        { key: 'status_data', label: 'Status Data' },
        { key: 'kode_bidang', label: 'Kode Bidang Statistik' },
        { key: 'digunakan_nasional', label: 'Digunakan Nasional/Daerah' },
        { key: 'kualitas', label: 'Kepuasan Kualitas Data' },
        { key: 'hasil_konsultasi', label: 'Hasil Konsultasi' },
        { key: 'durasi_detik', label: 'Durasi (detik)' },
        { key: 'rating', label: 'Rating Keseluruhan' },
        ...indIds.map((id) => ({ key: `ind_${id}`, label: `${id}. ${indikator_labels[String(id)] ?? `Indikator ${id}`}` })),
        { key: 'pengaduan', label: 'Pengaduan/Saran' },
      ]
      exportCsv(`responden-skd-kunjungan-${tahun}${triwulan ? `-tw${triwulan}` : ''}`, rows, cols)
    })
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="admin-h1">Responden SKD</h1>
          <p className="admin-subtitle">Responden yang telah mengisi evaluasi SKD/SKM (indikator kepuasan)</p>
        </div>
        <Button variant="outline" onClick={handleExport}>
          <Download className="w-4 h-4 mr-2" />
          Export CSV
        </Button>
      </div>

      {/* Summary cards */}
      {summary && (
        <div className="flex gap-4 flex-wrap">
          <div className="admin-card flex items-center gap-3 px-4 py-3">
            <Users className="w-5 h-5 text-blue-600" />
            <div>
              <p className="text-lg font-bold">{summary.total_users}</p>
              <p className="text-xs text-muted-foreground">Total Responden {tahun}</p>
            </div>
          </div>
          <div className="admin-card flex items-center gap-3 px-4 py-3">
            <ClipboardCheck className="w-5 h-5 text-orange-600" />
            <div>
              <p className="text-lg font-bold">{summary.skd_eligible}</p>
              <p className="text-xs text-muted-foreground">Eligible SKD/SKM{triwulan ? ` ${TW_LABELS[triwulan]}` : ''}</p>
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1 min-w-[200px]">
          <Label htmlFor="resp-search">Cari</Label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input id="resp-search" placeholder="Nama, instansi..." value={searchInput} onChange={e => setSearchInput(e.target.value)} className="pl-9" />
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor="resp-tahun">Tahun</Label>
          <select id="resp-tahun" value={tahun} onChange={e => { setTahun(e.target.value); setPage(1) }} className="h-9 border rounded px-3 text-sm bg-background">
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="resp-tw">Triwulan</Label>
          <select id="resp-tw" value={triwulan} onChange={e => { setTriwulan(e.target.value); setPage(1) }} className="h-9 border rounded px-3 text-sm bg-background">
            <option value="">Semua</option>
            <option value="1">TW I (Jan–Mar)</option>
            <option value="2">TW II (Apr–Jun)</option>
            <option value="3">TW III (Jul–Sep)</option>
            <option value="4">TW IV (Okt–Des)</option>
          </select>
        </div>

        <button
          onClick={() => { setSkdFilter(!skdFilter); setPage(1) }}
          className={`h-9 px-3 rounded-md border text-sm font-medium transition-all ${
            skdFilter
              ? 'bg-orange-600 text-white border-orange-600'
              : 'bg-background text-muted-foreground border-input hover:bg-muted/50'
          }`}
        >
          {skdFilter ? '✓ ' : ''}Eligible SKD/SKM saja
        </button>
      </div>

      {skdFilter && (
        <div className="text-xs text-muted-foreground bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
          Menampilkan responden dengan layanan PST (selain Keperluan Pimpinan &amp; Lainnya){triwulan ? ` pada ${TW_LABELS[triwulan]}` : ''} tahun {tahun}.
        </div>
      )}

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-md" />)}</div>
      ) : rows.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">Tidak ada data responden{skdFilter ? ' eligible SKD/SKM' : ''} untuk periode ini.</div>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                <th className="px-4 py-2 text-left w-10">No</th>
                <th className="px-4 py-2 text-left">Nama</th>
                <th className="px-4 py-2 text-left">Instansi</th>
                <th className="px-4 py-2 text-left">Layanan</th>
                <th className="px-4 py-2 text-left">Sarana</th>
                <th className="px-4 py-2 text-center">Kunjungan</th>
                <th className="px-4 py-2 text-left">Terakhir</th>
                <th className="px-4 py-2 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => (
                <tr key={r.id_user} className="border-t hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-2.5 text-muted-foreground">{(page - 1) * limit + idx + 1}</td>
                  <td className="px-4 py-2.5 font-medium">{r.nama}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{r.nama_instansi}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {parseLayanan(r.jenis_layanan).map((l, i) => (
                        <span key={i} className="px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 text-[11px] font-medium">{l}</span>
                      ))}
                      {r.layanan_lainnya && <span className="text-xs text-muted-foreground">({r.layanan_lainnya})</span>}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {parseSarana(r.sarana).map((c, i) => (
                        <span key={i} className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 text-[11px] font-medium">{saranaLabel(c)}</span>
                      ))}
                      {r.sarana_lainnya && <span className="text-xs text-muted-foreground">({r.sarana_lainnya})</span>}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-center font-semibold">{r.total_kunjungan}</td>
                  <td className="px-4 py-2.5 text-muted-foreground text-xs">{formatDate(r.max_visit)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <Button size="sm" variant="outline" onClick={() => setViewRow(r)} title="Lihat Detail">
                      <Eye className="w-3.5 h-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {pagination && (
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>Tampilkan</span>
            <select value={limit} onChange={e => { setLimit(Number(e.target.value)); setPage(1) }} className="border rounded px-2 py-1 text-sm bg-background">
              {[10, 25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            <span>per halaman</span>
            <span className="ml-2">Total: <strong>{pagination.total}</strong></span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="text-sm">{page} / {pagination.totalPages}</span>
            <Button variant="outline" size="sm" disabled={page >= pagination.totalPages} onClick={() => setPage(p => p + 1)}>
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* View detail dialog */}
      <Dialog open={!!viewRow} onOpenChange={open => !open && setViewRow(null)}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Detail Responden</DialogTitle>
          </DialogHeader>
          {viewRow && (
            <div className="space-y-4 py-2">
              {/* Photo + name + eligibility */}
              <div className="flex items-center gap-4">
                <img
                  src={`/api/guests/${viewRow.id_user}/photo`}
                  alt=""
                  className="w-14 h-14 rounded-full object-cover border-2 border-[--admin-border-strong] shrink-0"
                  onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                />
                <div>
                  <p className="text-lg font-bold">{viewRow.nama}</p>
                  <p className="text-sm text-muted-foreground">{viewRow.nama_instansi}</p>
                </div>
              </div>

              {/* Data Responden */}
              {viewProfile && (
                <div className="border-t pt-3">
                  <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Data Responden</p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <div><p className="text-[10px] text-muted-foreground">Email</p><p className="font-medium">{viewProfile.email || '-'}</p></div>
                    <div><p className="text-[10px] text-muted-foreground">Telepon</p><p className="font-medium">{viewProfile.notel || '-'}</p></div>
                    <div><p className="text-[10px] text-muted-foreground">Jenis Kelamin</p><p className="font-medium">{viewProfile.jeniskelamin || '-'}</p></div>
                    <div><p className="text-[10px] text-muted-foreground">Umur</p><p className="font-medium">{UMUR_OPTIONS.find(o => o.value === Number(viewProfile.umur))?.label ?? '-'}</p></div>
                    <div><p className="text-[10px] text-muted-foreground">Pendidikan</p><p className="font-medium">{PENDIDIKAN_OPTIONS.find(o => o.value === Number(viewProfile.pendidikan))?.label ?? '-'}</p></div>
                    <div><p className="text-[10px] text-muted-foreground">Pekerjaan</p><p className="font-medium">{PEKERJAAN_OPTIONS.find(o => o.value === Number(viewProfile.pekerjaan))?.label ?? '-'}{viewProfile.pekerjaan_lainnya ? ` (${viewProfile.pekerjaan_lainnya})` : ''}</p></div>
                    <div><p className="text-[10px] text-muted-foreground">Kategori Instansi</p><p className="font-medium">{KATEGORI_INSTANSI_OPTIONS.find(o => o.value === Number(viewProfile.kategori_instansi))?.label ?? '-'}{viewProfile.kategori_lainnya ? ` (${viewProfile.kategori_lainnya})` : ''}</p></div>
                    <div><p className="text-[10px] text-muted-foreground">Nama Instansi</p><p className="font-medium">{viewProfile.nama_instansi || '-'}</p></div>
                    <div><p className="text-[10px] text-muted-foreground">Pemanfaatan</p><p className="font-medium">{PEMANFAATAN_OPTIONS.find(o => o.value === Number(viewProfile.pemanfaatan))?.label ?? '-'}{viewProfile.pemanfaatan_lainnya ? ` (${viewProfile.pemanfaatan_lainnya})` : ''}</p></div>
                    <div><p className="text-[10px] text-muted-foreground">Disabilitas</p><p className="font-medium">{DISABILITAS_OPTIONS.find(o => o.value === Number(viewProfile.disabilitas))?.label ?? '-'}{Number(viewProfile.disabilitas) === 1 ? ` — ${JENIS_DISABILITAS_OPTIONS.find(o => o.value === Number(viewProfile.jenis_disabilitas))?.label ?? ''}` : ''}</p></div>
                  </div>
                </div>
              )}

              {/* Layanan akumulasi */}
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase mb-1.5">Layanan yang Digunakan</p>
                <div className="flex flex-wrap gap-1.5">
                  {parseLayanan(viewRow.jenis_layanan).map((l, i) => (
                    <span key={i} className="px-2.5 py-1 rounded-full bg-orange-100 text-orange-700 text-xs font-medium">{l}</span>
                  ))}
                  {viewRow.layanan_lainnya && <span className="text-xs text-muted-foreground self-center">({viewRow.layanan_lainnya})</span>}
                </div>
              </div>

              {/* Sarana akumulasi */}
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase mb-1.5">Sarana yang Digunakan</p>
                <div className="flex flex-wrap gap-1.5">
                  {parseSarana(viewRow.sarana).map((c, i) => (
                    <span key={i} className="px-2.5 py-1 rounded-full bg-blue-50 text-blue-600 text-xs font-medium">{saranaLabel(c)}</span>
                  ))}
                  {viewRow.sarana_lainnya && <span className="text-xs text-muted-foreground self-center">({viewRow.sarana_lainnya})</span>}
                </div>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-muted/40 rounded-lg p-3 text-center">
                  <p className="text-2xl font-bold">{viewRow.total_kunjungan}</p>
                  <p className="text-xs text-muted-foreground">Total Kunjungan</p>
                </div>
                <div className="bg-muted/40 rounded-lg p-3 text-center">
                  <p className="text-sm font-bold">{formatDate(viewRow.max_visit)}</p>
                  <p className="text-xs text-muted-foreground">Kunjungan Terakhir</p>
                </div>
              </div>

              {/* Visit history — each evaluated visit expands to its 16-indikator scores */}
              {viewVisits && viewVisits.length > 0 && (
                <div className="border-t pt-3">
                  <p className="text-sm font-semibold flex items-center gap-1.5 mb-1">
                    <Clock className="w-4 h-4" />
                    Riwayat Kunjungan ({viewVisits.length})
                  </p>
                  <p className="text-[11px] text-muted-foreground mb-2">
                    {evaluatedVisitCount > 0
                      ? `${evaluatedVisitCount} kunjungan dievaluasi — tekan "Lihat Evaluasi" untuk skor per indikator (kondisi tiap kunjungan).`
                      : isSkdEligible(viewRow.jenis_layanan)
                        ? 'Belum ada kunjungan yang dievaluasi.'
                        : 'Layanan yang digunakan tidak memerlukan evaluasi SKD.'}
                  </p>
                  <div className="max-h-72 overflow-y-auto space-y-1.5">
                    {viewVisits.map((v: GuestVisit) => (
                      <VisitHistoryRow key={v.id_kunjungan} visit={v} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewRow(null)}>Tutup</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
