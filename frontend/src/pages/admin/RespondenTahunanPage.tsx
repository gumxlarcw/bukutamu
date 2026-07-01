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
import { respondenApi, type RespondenRow, type RespondenKonsultasi } from '@/api/responden'
import { evaluationsApi } from '@/api/evaluations'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { exportCsv } from '@/lib/export-csv'

const TW_LABELS: Record<string, string> = { '1': 'TW I (Jan–Mar)', '2': 'TW II (Apr–Jun)', '3': 'TW III (Jul–Sep)', '4': 'TW IV (Okt–Des)' }

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

function optLabel(list: ReadonlyArray<{ value: number; label: string }>, val: unknown): string {
  if (val == null || val === '') return ''
  return list.find(o => o.value === Number(val))?.label ?? ''
}

/**
 * One "rincian data yang diminta" request (a konsultasi_pengunjung row) rendered as a
 * compact card. A visit can carry several. Only populated meta fields are shown so the
 * card stays readable inside the narrow detail dialog.
 */
function RequestedDataCard({ k, index }: { k: RespondenKonsultasi; index: number }) {
  const thn = k.tahun_awal
    ? (String(k.tahun_awal) === String(k.tahun_akhir) ? String(k.tahun_awal) : `${k.tahun_awal}–${k.tahun_akhir}`)
    : ''
  const dn = (k.digunakan_nasional == null || k.digunakan_nasional === '')
    ? '' : (Number(k.digunakan_nasional) === 1 ? 'Ya' : 'Tidak')
  const pubParts = [k.jenis_publikasi, k.judul_publikasi].filter(Boolean).join(' — ')
  const pub = pubParts ? pubParts + (k.tahun_publikasi ? ` (${k.tahun_publikasi})` : '') : ''

  const meta: Array<[string, string]> = ([
    ['Wilayah', k.wilayah_data ?? ''],
    ['Tahun', thn],
    ['Level', optLabel(LEVEL_DATA_OPTIONS, k.level_data)],
    ['Periode', optLabel(PERIODE_DATA_OPTIONS, k.periode_data)],
    ['Status', optLabel(STATUS_DATA_OPTIONS, k.status_data)],
    ['Kode Bidang', k.kode_bidang_statistik ?? ''],
    ['Digunakan Nasional', dn],
    ['Kepuasan Kualitas', k.kualitas != null && k.kualitas !== '' ? String(k.kualitas) : ''],
    ['Publikasi', pub],
  ] as Array<[string, string]>).filter(([, v]) => v.trim() !== '')

  return (
    <div className="rounded-md border bg-background p-2">
      <div className="flex items-start gap-2">
        <span className="shrink-0 text-[10px] font-bold text-orange-700 bg-orange-100 rounded px-1.5 py-0.5">#{index + 1}</span>
        <p className="text-[11px] font-medium leading-snug flex-1">
          {k.rincian_data || <span className="text-muted-foreground italic font-normal">Tanpa rincian</span>}
        </p>
      </div>
      {meta.length > 0 && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-1.5 pl-7">
          {meta.map(([label, value]) => (
            <div key={label} className="text-[10px] leading-tight">
              <span className="text-muted-foreground">{label}: </span>
              <span className="font-medium">{value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * One visit row in the history list. Every visit expands (button "Detail") to reveal its
 * full "rincian data yang diminta" (konsultasi_pengunjung) AND — for evaluated visits
 * (rating_pengunjung set) — its 16-indicator kepuasan scores. Each row owns its own
 * react-query fetches keyed by id_kunjungan, so results are cached per visit and only
 * fetched once expanded.
 */
function VisitHistoryRow({ visit }: { visit: GuestVisit }) {
  const [expanded, setExpanded] = useState(false)
  const isEvaluated = visit.rating_pengunjung !== null

  const { data: konsul, isLoading: konsulLoading } = useQuery({
    queryKey: ['responden-visit-konsul', visit.id_kunjungan],
    queryFn: () => respondenApi.visitDetail(visit.id_kunjungan).then(r => r.data.data),
    enabled: expanded,
  })

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
          <span className="text-amber-600 font-bold shrink-0">
            {'★'}{visit.rating_pengunjung}
          </span>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 shrink-0"
          onClick={() => setExpanded(e => !e)}
        >
          <Eye className="w-3.5 h-3.5 mr-1" />
          {expanded ? 'Tutup' : 'Detail'}
        </Button>
      </div>

      {expanded && (
        <div className="px-2 pb-2 border-t space-y-3">
          {/* Rincian data yang diminta (konsultasi_pengunjung) — semua kunjungan */}
          <div className="pt-2">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Rincian Data yang Diminta</p>
            {konsulLoading ? (
              <div className="space-y-1.5">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-10 rounded" />)}</div>
            ) : konsul && konsul.length > 0 ? (
              <div className="space-y-1.5">
                {konsul.map((k, i) => <RequestedDataCard key={k.id} k={k} index={i} />)}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground italic">Tidak ada rincian data yang diminta tercatat untuk kunjungan ini.</p>
            )}
          </div>

          {/* Evaluasi SKD (16 indikator) — hanya kunjungan yang dievaluasi */}
          {isEvaluated && (
            <div>
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Evaluasi SKD</p>
              {isLoading ? (
                <div className="space-y-1.5">
                  {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-6 rounded" />)}
                </div>
              ) : evalDetail && evalDetail.details && evalDetail.details.length > 0 ? (
                <>
                  <p className="text-[11px] text-muted-foreground mb-1">
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
                <p className="text-[11px] text-muted-foreground italic">Rincian indikator tidak tersedia untuk kunjungan ini.</p>
              )}
            </div>
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
          jenis_publikasi: ks.map(k => k.jenis_publikasi ?? '').join(' || '),
          judul_publikasi: ks.map(k => k.judul_publikasi ?? '').join(' || '),
          tahun_publikasi: ks.map(k => k.tahun_publikasi ?? '').join(' || '),
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
        { key: 'jenis_publikasi', label: 'Jenis Publikasi' },
        { key: 'judul_publikasi', label: 'Judul Publikasi' },
        { key: 'tahun_publikasi', label: 'Tahun Publikasi' },
        { key: 'hasil_konsultasi', label: 'Hasil Konsultasi' },
        { key: 'durasi_detik', label: 'Durasi (detik)' },
        { key: 'rating', label: 'Rating Keseluruhan' },
        ...indIds.map((id) => ({ key: `ind_${id}`, label: `${id}. ${indikator_labels[String(id)] ?? `Indikator ${id}`}` })),
        { key: 'pengaduan', label: 'Pengaduan/Saran' },
      ]
      exportCsv(`responden-skd-kunjungan-${tahun}${triwulan ? `-tw${triwulan}` : ''}`, rows, cols)
    })
  }

  // Export Markdown — satu seksi per kunjungan: identitas, layanan/sarana, tabel rincian data
  // (1 baris per permintaan), tabel 16 indikator, dan pengaduan. Lebih mudah dibaca/di-parse
  // untuk otomasi entri (mis. Claude di Chrome).
  const handleExportMd = () => {
    respondenApi.exportVisits({ tahun, triwulan: triwulan || undefined }).then(r => {
      const { visits, indikator_labels } = r.data.data
      const indIds = Object.keys(indikator_labels).map(Number).sort((a, b) => a - b)
      const lbl = (list: ReadonlyArray<{ value: number; label: string }>, val: unknown) =>
        list.find(o => o.value === Number(val))?.label ?? ''
      const cell = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
      const L: string[] = []
      L.push(`# Responden SKD ${tahun}${triwulan ? ` — ${TW_LABELS[triwulan]}` : ''} (${visits.length} kunjungan)`, '')
      visits.forEach((v, i) => {
        L.push(`## ${i + 1}. ${v.nama || '-'}${v.nama_instansi ? ` — ${v.nama_instansi}` : ''}  (ID Kunjungan: ${v.id_kunjungan})`, '')
        L.push('**Identitas & Kunjungan**')
        L.push(`- ID Kunjungan: ${v.id_kunjungan}`)
        L.push(`- ID Responden: ${v.id_user}`)
        L.push(`- Tanggal Kunjungan: ${v.date_visit}`)
        L.push(`- Tanggal Registrasi: ${v.tgldatang ?? '-'}`)
        L.push(`- No. Antrian: ${v.nomor_antrian ?? '-'}`)
        L.push(`- Email / Telepon: ${v.email ?? '-'} / ${v.notel ?? '-'}`)
        L.push(`- Jenis Kelamin: ${v.jeniskelamin ?? '-'}`)
        L.push(`- Umur: ${lbl(UMUR_OPTIONS, v.umur) || '-'}`)
        L.push(`- Pendidikan: ${lbl(PENDIDIKAN_OPTIONS, v.pendidikan) || '-'}`)
        L.push(`- Pekerjaan: ${lbl(PEKERJAAN_OPTIONS, v.pekerjaan) || '-'}${v.pekerjaan_lainnya ? ` (${v.pekerjaan_lainnya})` : ''}`)
        L.push(`- Kategori Instansi: ${lbl(KATEGORI_INSTANSI_OPTIONS, v.kategori_instansi) || '-'}${v.kategori_lainnya ? ` (${v.kategori_lainnya})` : ''}`)
        L.push(`- Pemanfaatan: ${lbl(PEMANFAATAN_OPTIONS, v.pemanfaatan) || '-'}${v.pemanfaatan_lainnya ? ` (${v.pemanfaatan_lainnya})` : ''}`)
        L.push(`- Disabilitas: ${lbl(DISABILITAS_OPTIONS, v.disabilitas) || '-'}${Number(v.disabilitas) === 1 && v.jenis_disabilitas ? ` (${lbl(JENIS_DISABILITAS_OPTIONS, v.jenis_disabilitas)})` : ''}`)
        L.push('')
        L.push('**Layanan & Sarana**')
        L.push(`- Layanan: ${parseLayanan(v.jenis_layanan).join(', ') || '-'}${v.layanan_lainnya ? ` (${v.layanan_lainnya})` : ''}`)
        L.push(`- Sarana: ${parseSarana(v.sarana).map(saranaLabel).join(', ') || '-'}${v.sarana_lainnya ? ` (${v.sarana_lainnya})` : ''}`)
        L.push(`- Hasil Konsultasi: ${v.hasil_konsultasi ?? '-'}`)
        L.push(`- Durasi: ${v.durasi_detik ?? '-'} detik`)
        L.push('')
        const ks = v.konsultasi ?? []
        if (ks.length) {
          L.push('**Rincian Data Diminta**', '')
          L.push('| # | Rincian | Wilayah | Tahun | Level | Periode | Status | Kode Bidang | Digunakan Nasional | Kualitas | Jenis Pub | Judul Pub | Thn Pub |')
          L.push('|---|---------|---------|-------|-------|---------|--------|-------------|--------------------|----------|-----------|-----------|---------|')
          ks.forEach((k, ki) => {
            const thn = k.tahun_awal ? (String(k.tahun_awal) === String(k.tahun_akhir) ? String(k.tahun_awal) : `${k.tahun_awal}-${k.tahun_akhir}`) : ''
            const dn = (k.digunakan_nasional == null || k.digunakan_nasional === '') ? '' : (Number(k.digunakan_nasional) === 1 ? 'Ya' : 'Tidak')
            L.push(`| ${ki + 1} | ${cell(k.rincian_data)} | ${cell(k.wilayah_data)} | ${cell(thn)} | ${cell(lbl(LEVEL_DATA_OPTIONS, k.level_data))} | ${cell(lbl(PERIODE_DATA_OPTIONS, k.periode_data))} | ${cell(lbl(STATUS_DATA_OPTIONS, k.status_data))} | ${cell(k.kode_bidang_statistik)} | ${cell(dn)} | ${cell(k.kualitas)} | ${cell(k.jenis_publikasi)} | ${cell(k.judul_publikasi)} | ${cell(k.tahun_publikasi)} |`)
          })
          L.push('')
        }
        L.push(`**Evaluasi SKD** (Rating Keseluruhan: ${v.rating_pengunjung ?? '-'}/10)`, '')
        L.push('| No | Indikator | Kepuasan |', '|----|-----------|----------|')
        indIds.forEach(id => {
          L.push(`| ${id} | ${cell(indikator_labels[String(id)] ?? `Indikator ${id}`)} | ${v.indikator?.[String(id)] ?? '-'} |`)
        })
        L.push('')
        L.push(`**Pengaduan/Saran:** ${v.pengaduan ?? '-'}`, '', '---', '')
      })
      const blob = new Blob([L.join('\n')], { type: 'text/markdown;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `responden-skd-${tahun}${triwulan ? `-tw${triwulan}` : ''}.md`
      a.click()
      URL.revokeObjectURL(url)
    })
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="admin-h1">Responden SKD</h1>
          <p className="admin-subtitle">Responden yang telah mengisi evaluasi SKD/SKM (indikator kepuasan)</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleExport}>
            <Download className="w-4 h-4 mr-2" />
            Export CSV
          </Button>
          <Button variant="outline" onClick={handleExportMd}>
            <Download className="w-4 h-4 mr-2" />
            Export MD
          </Button>
        </div>
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
                    Tekan &quot;Detail&quot; pada tiap kunjungan untuk melihat rincian data yang diminta
                    {evaluatedVisitCount > 0 ? ` & skor evaluasi per indikator (${evaluatedVisitCount} kunjungan dievaluasi)` : ''}.
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
