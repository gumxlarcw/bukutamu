import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getApiErrorMessage } from '@/lib/apiError'
import { visitsApi } from '@/api/visits'
import { consultationsApi } from '@/api/consultations'
import type { Visit, VisitStatus, ConsultationDataRow, DtsenDataRow } from '@/types/visit'
import {
  SERVICE_OPTIONS, parseLayanan, parseSarana, saranaLabel,
  STATUS_DATA_OPTIONS, LEVEL_DATA_OPTIONS, PERIODE_DATA_OPTIONS,
  JENIS_KONSULTASI_DTSEN_OPTIONS, HASIL_DTSEN_OPTIONS,
} from '@/types/visit'
import { SARANA_OPTIONS } from '@/types/guest'
import { CheckCircle, Lock, Trash2, ClipboardList, Star, Database, ChevronRight as CR } from 'lucide-react'
import { VisitFilters } from '@/components/admin/VisitFilters'
import type { VisitFilterState } from '@/components/admin/VisitFilters'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Download } from 'lucide-react'
import { exportCsv } from '@/lib/export-csv'
import { useAuth } from '@/providers/AuthProvider'
import { canFinalizeLayanan, parseLayananForRole, isResepsionisLayanan, isSkdLayanan, isDtsenLayanan, nextStatusAfterCompletion } from '@/lib/role-access'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'

/* Status flow per layanan:
 *  - antri → proses              (semua)
 *  - proses → menunggu_evaluasi  (SKD inti) via nextStatusAfterCompletion()
 *  - proses → selesai            (DTSEN / Lainnya / Pimpinan) via nextStatusAfterCompletion()
 *  - menunggu_evaluasi → selesai (admin override; biasanya auto dari tablet eval)
 * Tidak ada konstanta linear lagi — pakai helper `nextStatusAfterCompletion` di logic
 * per-visit supaya non-SKD tidak salah jalur lewat menunggu_evaluasi. */

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString('id-ID', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return dateStr
  }
}

// Helper: label dari array option
function optLabel<T extends { value: number; label: string }>(opts: readonly T[], v: number | null | undefined): string {
  if (v === null || v === undefined) return '-'
  const found = opts.find(o => o.value === Number(v))
  return found?.label ?? String(v)
}

/**
 * Accordion detail per data konsultasi. Klik baris untuk expand semua field.
 * Header ringkas: rincian_data + wilayah_data + chip status_data.
 * Detail expanded: tahun range, level, periode, jenis_publikasi, dll dengan label friendly.
 */
function ConsultationDataAccordion({ rows }: { rows: ConsultationDataRow[] }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  return (
    <div className="text-sm">
      <p className="font-semibold mb-2 flex items-center gap-2">
        <ClipboardList className="w-4 h-4 text-orange-600" />
        Data Konsultasi ({rows.length} item)
      </p>
      <div className="space-y-1.5">
        {rows.map((row, i) => {
          const isOpen = openIdx === i
          // Backend CI sering return tinyint sebagai string ("4") → normalize ke number
          // supaya strict equality + ternary chip warna + dataNotObtained gate semua benar.
          const statusNum = Number(row.status_data)
          const statusOpt = STATUS_DATA_OPTIONS.find(o => o.value === statusNum)
          const statusTone =
            statusNum === 1 ? 'bg-emerald-100 text-emerald-700' :
            statusNum === 2 ? 'bg-amber-100 text-amber-700' :
            statusNum === 3 ? 'bg-red-100 text-red-700' :
                              'bg-slate-100 text-slate-600'
          return (
            <div key={i} className="rounded-lg border bg-white/60">
              <button
                type="button"
                onClick={() => setOpenIdx(isOpen ? null : i)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/30 transition-colors rounded-lg"
              >
                <CR className={`w-3.5 h-3.5 shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                <span className="text-xs font-semibold tabular-nums text-muted-foreground w-6 shrink-0">#{i + 1}</span>
                <span className="flex-1 min-w-0 truncate">{row.rincian_data || <em className="text-muted-foreground">(tanpa rincian)</em>}</span>
                <span className="text-xs text-muted-foreground truncate hidden sm:inline">{row.wilayah_data || '-'}</span>
                {statusOpt && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${statusTone}`}>{statusOpt.label}</span>
                )}
              </button>
              {isOpen && (() => {
                // Status 3=tidak diperoleh, 4=belum diperoleh → field tahun/level/periode/wilayah
                // tidak relevan. Pakai statusNum (sudah Number()-ed di scope outer) supaya
                // tidak terkecoh string vs number dari backend.
                const dataNotObtained = statusNum === 3 || statusNum === 4
                const digunakanNum = row.digunakan_nasional === null || row.digunakan_nasional === undefined ? null : Number(row.digunakan_nasional)
                const showDash = (raw: string) => dataNotObtained ? '-' : raw
                return (
                  <div className="px-3 pb-3 pt-1 grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-2 text-xs border-t bg-muted/10">
                    <DetailField label="Rincian Data" value={row.rincian_data || '-'} colSpan={3} />
                    <DetailField label="Status Data"  value={optLabel(STATUS_DATA_OPTIONS, statusNum)} colSpan={3} />
                    <DetailField label="Wilayah Data" value={showDash(row.wilayah_data || '-')} colSpan={3} />
                    <DetailField label="Tahun Awal"   value={showDash(row.tahun_awal !== null && row.tahun_awal !== undefined ? String(row.tahun_awal) : '-')} />
                    <DetailField label="Tahun Akhir"  value={showDash(row.tahun_akhir !== null && row.tahun_akhir !== undefined ? String(row.tahun_akhir) : '-')} />
                    <DetailField label="Level Data"   value={dataNotObtained ? '-' : optLabel(LEVEL_DATA_OPTIONS, row.level_data === null || row.level_data === undefined ? null : Number(row.level_data))} />
                    <DetailField label="Periode Data" value={dataNotObtained ? '-' : optLabel(PERIODE_DATA_OPTIONS, row.periode_data === null || row.periode_data === undefined ? null : Number(row.periode_data))} />
                    <DetailField label="Digunakan Nasional" value={digunakanNum === 1 ? 'Ya' : digunakanNum === 0 ? 'Tidak' : '-'} />
                    {(row.jenis_publikasi || row.judul_publikasi || row.tahun_publikasi) && (
                      <>
                        <DetailField label="Jenis Publikasi" value={row.jenis_publikasi || '-'} />
                        <DetailField label="Judul Publikasi" value={row.judul_publikasi || '-'} colSpan={2} />
                        <DetailField label="Tahun Publikasi" value={row.tahun_publikasi !== null ? String(row.tahun_publikasi) : '-'} />
                      </>
                    )}
                    {row.kualitas !== null && row.kualitas !== undefined && (
                      <DetailField label="Kualitas (rating tamu)" value={`${row.kualitas} / 10`} />
                    )}
                  </div>
                )
              })()}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function DetailField({ label, value, colSpan = 1 }: { label: string; value: string; colSpan?: 1 | 2 | 3 }) {
  const cls = colSpan === 3 ? 'col-span-2 md:col-span-3' : colSpan === 2 ? 'col-span-2' : ''
  return (
    <div className={cls}>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{label}</p>
      <p className="text-foreground leading-tight mt-0.5 break-words">{value}</p>
    </div>
  )
}

/**
 * Hasil Evaluasi SKD: tampilkan rating overall + per-indikator dengan label lengkap.
 * Bar visualisasi sederhana per indikator (skor 1-10 → bar width %).
 */
function EvaluationResults({
  rating,
  rows,
  labels,
}: {
  rating: number | null
  rows: Array<{ indikator_id: number; kepuasan: number | string | null }>
  labels: Record<string, string>
}) {
  const sortedRows = [...rows].sort((a, b) => Number(a.indikator_id) - Number(b.indikator_id))
  // Defensive: backend CI bisa return kepuasan sebagai string ("9") — tanpa Number()
  // explicit, reduce + akan jadi string concat ("0" + "9" = "09", dst) bukan jumlah aritmetik.
  const avg = (() => {
    const nums = rows
      .map(r => r.kepuasan === null || r.kepuasan === undefined ? null : Number(r.kepuasan))
      .filter((v): v is number => v !== null && !Number.isNaN(v))
    return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length
  })()
  const fmt2 = (n: number) => n.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return (
    <div className="text-sm">
      <p className="font-semibold mb-2 flex items-center gap-2">
        <Star className="w-4 h-4 text-amber-500" />
        Hasil Evaluasi SKD
        <span className="text-xs text-muted-foreground font-normal">({rows.length} indikator dinilai)</span>
      </p>
      <div className="rounded-lg border bg-amber-50/30 p-3 space-y-3">
        {/* Rating overall + avg per indikator */}
        <div className="flex flex-wrap items-center gap-4 pb-2 border-b border-amber-200/60">
          {rating !== null && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Rating Overall</p>
              <p className="text-2xl font-bold tabular-nums text-amber-700">{Number(rating)} <span className="text-sm font-normal text-muted-foreground">/ 10</span></p>
            </div>
          )}
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Rata-rata Indikator</p>
            <p className="text-2xl font-bold tabular-nums text-foreground">{fmt2(avg)} <span className="text-sm font-normal text-muted-foreground">/ 10</span></p>
          </div>
        </div>
        {/* Per-indikator bar */}
        <div className="space-y-1.5">
          {sortedRows.map(r => {
            const score = r.kepuasan === null || r.kepuasan === undefined ? 0 : Number(r.kepuasan)
            const pct = (score / 10) * 100
            const tone = score >= 8 ? 'bg-emerald-500' : score >= 6 ? 'bg-sky-500' : score >= 4 ? 'bg-amber-500' : 'bg-red-500'
            const label = labels[String(r.indikator_id)] ?? `Indikator ${r.indikator_id}`
            return (
              <div key={r.indikator_id} className="grid grid-cols-[24px_1fr_36px] items-center gap-2 text-xs">
                <span className="text-[10px] font-bold text-muted-foreground tabular-nums bg-muted rounded px-1 py-0.5 text-center">{Number(r.indikator_id)}</span>
                <div className="min-w-0">
                  <p className="text-foreground leading-snug line-clamp-2" title={label}>{label}</p>
                  <div className="h-1.5 mt-1 bg-muted/60 rounded overflow-hidden">
                    <div className={`h-full ${tone} transition-all`} style={{ width: `${Math.max(pct, 2)}%` }} />
                  </div>
                </div>
                <span className="text-sm font-bold tabular-nums text-right">{score}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/**
 * Detail Konsultasi DTSEN (single row per visit di tabel dtsen_konsultasi).
 * Read-only — petugas DTSEN edit lewat /admin/dtsen/{id}/form.
 */
function DtsenResultDetail({ row }: { row: DtsenDataRow }) {
  // #16 — CI3 returns these numerics as strings; coerce once so === and label lookups work.
  const jenisNum = Number(row.jenis_konsultasi_dtsen)
  const hasilNum = Number(row.hasil)
  const jenisOpt = JENIS_KONSULTASI_DTSEN_OPTIONS.find(o => o.value === jenisNum)
  const hasilOpt = HASIL_DTSEN_OPTIONS.find(o => o.value === hasilNum)
  const hasilTone =
    hasilNum === 1 ? 'bg-emerald-100 text-emerald-700' :
    hasilNum === 2 ? 'bg-amber-100 text-amber-700' :
                      'bg-red-100 text-red-700'
  return (
    <div className="text-sm">
      <p className="font-semibold mb-2 flex items-center gap-2">
        <Database className="w-4 h-4 text-sky-600" />
        Detail Konsultasi DTSEN
      </p>
      <div className="rounded-lg border bg-sky-50/30 p-3 grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-2 text-xs">
        <DetailField label="Jenis Konsultasi" value={jenisOpt?.label ?? `Kode ${jenisNum}`} colSpan={2} />
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Hasil</p>
          <span className={`inline-block text-xs font-bold px-2 py-0.5 rounded ${hasilTone} mt-0.5`}>
            {hasilOpt?.label ?? `Kode ${hasilNum}`}
          </span>
        </div>
        {row.nik_dirujuk && <DetailField label="NIK Dirujuk" value={row.nik_dirujuk} colSpan={3} />}
        <DetailField label="Catatan" value={row.catatan || '(tidak ada catatan)'} colSpan={3} />
        {row.tanggal_input && <DetailField label="Tanggal Input" value={new Date(row.tanggal_input).toLocaleString('id-ID')} colSpan={3} />}
      </div>
    </div>
  )
}

function VisitDetailPanel({ visit }: { visit: Visit }) {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const role = user?.role
  const canEdit = canFinalizeLayanan(role, parseLayananForRole(visit.jenis_layanan))
  // Hard delete kunjungan = aksi admin-only (mirror Api_base::require_role('admin')).
  // Operator legacy NOT included supaya konsisten dengan backend.
  const canDelete = role === 'admin' || role === 'superadmin'
  // Layanan front-office (Lainnya / Keperluan Pimpinan) WAJIB punya keterangan
  // sebelum bisa diselesaikan — cermin gate backend Visits::status.
  const needsKeterangan = parseLayananForRole(visit.jenis_layanan).some(isResepsionisLayanan)

  const [editServices, setEditServices] = useState<string[]>(() => parseLayanan(visit.jenis_layanan))
  const [editLayananLainnya, setEditLayananLainnya] = useState(visit.layanan_lainnya ?? '')
  const [editSarana, setEditSarana] = useState<number[]>(() => parseSarana(visit.sarana))
  const [editSaranaLainnya, setEditSaranaLainnya] = useState(visit.sarana_lainnya ?? '')
  const [editRingkasan, setEditRingkasan] = useState('')

  const { data: consultationData } = useQuery({
    queryKey: ['consultation-data', visit.id_kunjungan],
    queryFn: () => consultationsApi.getData(visit.id_kunjungan).then(r => r.data.data),
  })

  // Fetch visit detail unconditionally — punya konsultasi + evaluasi + dtsen + indikator_labels
  // yang dipakai untuk render section detail, hasil evaluasi, dan catatan DTSEN.
  const { data: visitDetail } = useQuery({
    queryKey: ['visit-detail', visit.id_kunjungan],
    queryFn: () => visitsApi.get(visit.id_kunjungan).then(r => r.data.data),
  })

  // Backend Visits::detail return shape: { visit, consultation[], evaluation[], dtsen, indikator_labels }
  type VisitDetail = {
    consultation?: Array<{ hasil_konsultasi?: string | null }>
    evaluation?: Array<{ indikator_id: number; kepuasan: number | null }>
    dtsen?: DtsenDataRow | null
    indikator_labels?: Record<string, string>
  }
  const detail = visitDetail as unknown as VisitDetail | undefined
  const savedKeterangan = (() => {
    const first = detail?.consultation?.[0]
    return first?.hasil_konsultasi ? String(first.hasil_konsultasi).trim() : ''
  })()
  const hasKeterangan = savedKeterangan.length > 0
  // Catatan: gate `blockedByKeterangan` di-handle inline di handleFinalize() — kalau true,
  // popup Dialog muncul alih-alih disable button. Lebih actionable buat user.

  // Pre-fill editRingkasan dari hasil konsultasi yang sudah disimpan petugas via form
  // (SKD inti / Lainnya / Pimpinan — semua pakai field konsultasi_pengunjung.hasil_konsultasi).
  // Untuk DTSEN, hasil ada di tabel sendiri (dtsen_konsultasi.catatan) — ditampilkan read-only
  // di section terpisah, tidak di-pre-fill ke textarea ini.
  useEffect(() => {
    if (hasKeterangan && editRingkasan === '') {
      setEditRingkasan(savedKeterangan)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKeterangan])

  // Domain flags untuk conditional rendering section
  const layananList = parseLayanan(visit.jenis_layanan)
  const hasSkd  = layananList.some(isSkdLayanan)
  const hasDtsen = layananList.some(isDtsenLayanan)
  const evaluationRows = detail?.evaluation ?? []
  const dtsenData = detail?.dtsen ?? null
  const indikatorLabels = detail?.indikator_labels ?? {}

  const statusMutation = useMutation({
    mutationFn: (status: VisitStatus) => visitsApi.updateStatus(visit.id_kunjungan, status),
    onSuccess: () => {
      toast.success('Status diperbarui')
      queryClient.invalidateQueries({ queryKey: ['visits'] })
    },
    onError: () => toast.error('Gagal memperbarui status'),
  })

  const serviceMutation = useMutation({
    mutationFn: () => visitsApi.updateService(visit.id_kunjungan, {
      jenis_layanan: editServices,
      layanan_lainnya: editLayananLainnya || undefined,
      sarana: editSarana,
      sarana_lainnya: editSaranaLainnya || undefined,
    }),
    onSuccess: () => {
      toast.success('Layanan & sarana diperbarui')
      queryClient.invalidateQueries({ queryKey: ['visits'] })
    },
    onError: () => toast.error('Gagal memperbarui'),
  })

  const summaryMutation = useMutation({
    mutationFn: () => visitsApi.updateSummary(visit.id_kunjungan, editRingkasan),
    onSuccess: () => {
      toast.success('Ringkasan disimpan')
      queryClient.invalidateQueries({ queryKey: ['visits'] })
      // Refresh visit-detail query supaya gate Selesai langsung unlock setelah ringkasan disimpan.
      queryClient.invalidateQueries({ queryKey: ['visit-detail', visit.id_kunjungan] })
    },
    onError: () => toast.error('Gagal menyimpan ringkasan'),
  })

  const deleteMutation = useMutation({
    mutationFn: () => visitsApi.delete(visit.id_kunjungan),
    onSuccess: () => {
      const label = visit.nomor_antrian ?? `#${visit.id_kunjungan}`
      toast.success(`Kunjungan ${label} dihapus`)
      // Invalidate — row akan hilang dari list, panel collapse otomatis.
      queryClient.invalidateQueries({ queryKey: ['visits'] })
    },
    onError: (e: unknown) => {
      toast.error(getApiErrorMessage(e, 'Gagal menghapus kunjungan'))
    },
  })

  const handleDelete = () => {
    const label = visit.nomor_antrian ?? `#${visit.id_kunjungan}`
    const layananStr = parseLayanan(visit.jenis_layanan).join(', ') || '-'
    const confirmed = window.confirm(
      `Hapus kunjungan ${label}?\n\n` +
      `Tamu    : ${visit.nama}\n` +
      `Layanan : ${layananStr}\n` +
      `Tanggal : ${formatDate(visit.date_visit)}\n\n` +
      `Aksi ini juga menghapus data konsultasi & evaluasi terkait.\n` +
      `TIDAK BISA di-undo.`
    )
    if (confirmed) deleteMutation.mutate()
  }

  // Tentukan next status berdasarkan posisi sekarang + jenis layanan:
  // - 'antri'              → 'proses' (semua role)
  // - 'proses'             → tergantung layanan: SKD → 'menunggu_evaluasi', lainnya → 'selesai'
  // - 'menunggu_evaluasi'  → 'selesai' (admin only — biasanya transit otomatis dari tablet eval)
  // - 'selesai'/null       → tidak ada next
  const nextStatus: VisitStatus | undefined =
    visit.status === 'antri'             ? 'proses' :
    visit.status === 'proses'            ? nextStatusAfterCompletion(parseLayananForRole(visit.jenis_layanan)) :
    visit.status === 'menunggu_evaluasi' ? 'selesai' :
    undefined

  // Popup state: tampil saat petugas klik Selesai tapi keterangan kosong (layanan resepsionis).
  const [showKeteranganDialog, setShowKeteranganDialog] = useState(false)

  // Wrapper yang intercept tombol Selesai sebelum mutation. Gate FE-side:
  // - kalau visit butuh keterangan dan kosong → popup, jangan kirim ke backend
  // - kalau lolos → mutasi normal
  const handleFinalize = (target: VisitStatus) => {
    if (target === 'selesai' && needsKeterangan && !hasKeterangan && !editRingkasan.trim()) {
      setShowKeteranganDialog(true)
      return
    }
    statusMutation.mutate(target)
  }

  return (
    <div className="px-4 pb-4 space-y-4 bg-muted/30 rounded-b-lg border-t">
      {/* Visitor info */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-4 text-sm">
        <div>
          <p className="text-muted-foreground">Nama</p>
          <p className="font-medium">{visit.nama}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Instansi</p>
          <p className="font-medium">{visit.nama_instansi}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Sumber</p>
          <p className="font-medium">
            {visit.created_by === 'kiosk' ? (
              <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-700 text-xs font-medium">Kiosk</span>
            ) : visit.created_by?.startsWith('admin:') ? (
              <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">Admin ({visit.created_by.replace('admin:', '')})</span>
            ) : (
              <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs font-medium">{visit.created_by ?? '-'}</span>
            )}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">No. Antrian</p>
          <p className="font-medium">{visit.nomor_antrian ?? '-'}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Sarana</p>
          <div className="flex flex-wrap gap-1 mt-0.5">
            {parseSarana(visit.sarana).map((c, i) => (
              <span key={i} className="inline-block px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 text-xs font-medium">{saranaLabel(c)}</span>
            ))}
            {visit.sarana_lainnya && <span className="text-xs text-muted-foreground">({visit.sarana_lainnya})</span>}
            {!visit.sarana && <span className="text-sm">-</span>}
          </div>
        </div>
        {visit.rating_pengunjung !== null && (
          <div>
            <p className="text-muted-foreground">Rating</p>
            <p className="font-medium">{visit.rating_pengunjung}/10</p>
          </div>
        )}
        {visit.durasi_detik !== null && (
          <div>
            <p className="text-muted-foreground">Durasi</p>
            <p className="font-medium">{Math.round(visit.durasi_detik / 60)} menit</p>
          </div>
        )}
      </div>

      {/* ── Detail Data Konsultasi (accordion per row) ── */}
      {consultationData && consultationData.length > 0 && (
        <ConsultationDataAccordion rows={consultationData} />
      )}

      {/* ── Hasil Evaluasi SKD ── */}
      {hasSkd && evaluationRows.length > 0 && (
        <EvaluationResults
          rating={visit.rating_pengunjung}
          rows={evaluationRows}
          labels={indikatorLabels}
        />
      )}

      {/* ── Detail Konsultasi DTSEN ── */}
      {hasDtsen && dtsenData && (
        <DtsenResultDetail row={dtsenData} />
      )}

      {/* Read-only banner untuk role yang tidak berwenang atas layanan visit ini */}
      {!canEdit && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-amber-50 border border-amber-200 text-amber-800 text-xs">
          <Lock className="w-3.5 h-3.5 shrink-0" />
          <span>
            Read-only: layanan visit ini di luar kewenangan role Anda. Hanya petugas
            yang berwenang yang bisa mengubah data, status, atau ringkasan.
          </span>
        </div>
      )}

      {/* Status actions — tombol Selesai langsung untuk Lainnya/Pimpinan/DTSEN (skip menunggu_evaluasi) */}
      {nextStatus && canEdit && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-muted-foreground">Ubah status ke:</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => handleFinalize(nextStatus)}
            disabled={statusMutation.isPending}
          >
            <StatusBadge status={nextStatus} />
          </Button>
          {needsKeterangan && nextStatus === 'selesai' && !hasKeterangan && (
            <span className="text-[11px] text-amber-700 italic">
              ⓘ Wajib isi keterangan dulu (popup akan muncul)
            </span>
          )}
        </div>
      )}

      {/* Dialog popup: muncul saat petugas klik Selesai tapi keterangan kosong (resepsionis only).
          Blocking — user harus pilih: tutup dialog & isi field, ATAU isi inline di textarea dialog. */}
      <Dialog open={showKeteranganDialog} onOpenChange={setShowKeteranganDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-700">
              <Lock className="w-5 h-5" />
              Keterangan Wajib Diisi
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              Visit kategori <strong>Keperluan Pimpinan / Lainnya</strong> wajib punya
              keterangan sebelum bisa ditandai <strong>Selesai</strong>.
            </p>
            <p className="text-muted-foreground text-xs">
              Tulis catatan singkat tentang keperluan tamu (mis. siapa yang ditemui, hasil pertemuan).
            </p>
            <textarea
              rows={4}
              className="w-full border rounded px-3 py-2 text-sm bg-background resize-none"
              placeholder="Contoh: Bertemu Kepala BPS terkait koordinasi data sensus..."
              value={editRingkasan}
              onChange={e => setEditRingkasan(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowKeteranganDialog(false)}>
              Batal
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              disabled={!editRingkasan.trim() || summaryMutation.isPending || statusMutation.isPending}
              onClick={async () => {
                // Simpan keterangan dulu (PUT /api/visits/{id}/summary), lalu transit status=selesai.
                // Backend `Visits::status` gate verifikasi keterangan ada di DB sebelum allow selesai —
                // kalau urutan kebalik, gate akan reject.
                try {
                  await summaryMutation.mutateAsync()
                  await statusMutation.mutateAsync('selesai')
                  setShowKeteranganDialog(false)
                } catch {
                  /* toast error sudah di-handle oleh masing-masing mutation */
                }
              }}
            >
              {summaryMutation.isPending || statusMutation.isPending ? 'Menyimpan...' : 'Simpan & Selesaikan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit layanan + sarana */}
      <div className={`space-y-3 ${canEdit ? '' : 'opacity-50 pointer-events-none select-none'}`}>
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Layanan <span className="text-xs font-normal text-muted-foreground">(boleh lebih dari satu)</span></p>
          <div className="flex flex-wrap gap-1.5">
            {SERVICE_OPTIONS.map(s => {
              const active = editServices.includes(s)
              return (
                <button key={s} type="button"
                  onClick={() => {
                    setEditServices(prev => active ? prev.filter(x => x !== s) : [...prev, s])
                    if (s === 'Lainnya' && active) setEditLayananLainnya('')
                  }}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-all ${active ? 'border-orange-400 bg-orange-50 text-orange-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                >
                  {active && <CheckCircle className="w-3 h-3" />}
                  {s}
                </button>
              )
            })}
          </div>
          {editServices.includes('Lainnya') && (
            <input type="text" className="w-full max-w-xs h-8 border rounded px-3 text-xs bg-background mt-1" placeholder="Sebutkan layanan lainnya" value={editLayananLainnya} onChange={e => setEditLayananLainnya(e.target.value)} />
          )}
        </div>

        <div className="space-y-1.5">
          <p className="text-sm font-medium">Sarana <span className="text-xs font-normal text-muted-foreground">(boleh lebih dari satu)</span></p>
          <div className="flex flex-wrap gap-1.5">
            {SARANA_OPTIONS.map(o => {
              const active = editSarana.includes(o.value)
              return (
                <button key={o.value} type="button"
                  onClick={() => {
                    setEditSarana(prev => active ? prev.filter(v => v !== o.value) : [...prev, o.value])
                    if (o.value === 32 && active) setEditSaranaLainnya('')
                  }}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-all ${active ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                >
                  {active && <CheckCircle className="w-3 h-3" />}
                  {o.label}
                </button>
              )
            })}
          </div>
          {editSarana.includes(32) && (
            <input type="text" className="w-full max-w-xs h-8 border rounded px-3 text-xs bg-background mt-1" placeholder="Sebutkan sarana lainnya" value={editSaranaLainnya} onChange={e => setEditSaranaLainnya(e.target.value)} />
          )}
        </div>

        <Button
          size="sm"
          variant="outline"
          onClick={() => serviceMutation.mutate()}
          disabled={serviceMutation.isPending || editServices.length === 0 || editSarana.length === 0}
        >
          {serviceMutation.isPending ? 'Menyimpan...' : 'Simpan Layanan & Sarana'}
        </Button>
      </div>

      {/* Edit ringkasan — pre-filled dari form konsultasi untuk SKD, dari kosong untuk Resepsionis */}
      <div className={`space-y-1 ${canEdit ? '' : 'opacity-50 pointer-events-none select-none'}`}>
        <p className="text-sm text-muted-foreground">
          {needsKeterangan ? 'Ringkasan / Keterangan' :
           hasSkd          ? 'Ringkasan / Hasil Konsultasi (dari Form)' :
                             'Ringkasan / Catatan'}
          {needsKeterangan && <span className="text-red-600 ml-1">*wajib</span>}
        </p>
        {hasSkd && hasKeterangan && (
          <p className="text-[11px] text-muted-foreground italic">
            Diisi otomatis dari form konsultasi yang disimpan petugas PST. Anda bisa edit untuk koreksi.
          </p>
        )}
        {needsKeterangan && hasKeterangan && (
          <p className="text-xs text-muted-foreground italic">
            Keterangan tersimpan: "{savedKeterangan}"
          </p>
        )}
        <textarea
          rows={3}
          className="w-full border rounded px-3 py-2 text-sm bg-background resize-none"
          placeholder={needsKeterangan ? 'Tulis keterangan kunjungan (mis. dari instansi mana, keperluan apa)...' : 'Catatan ringkasan...'}
          value={editRingkasan}
          onChange={e => setEditRingkasan(e.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => summaryMutation.mutate()}
          disabled={summaryMutation.isPending || !editRingkasan.trim() || !canEdit}
        >
          {summaryMutation.isPending ? 'Menyimpan...' : 'Simpan Ringkasan'}
        </Button>
      </div>

      {/* Zona Berbahaya — admin/superadmin only. Hard delete kunjungan + cascade. */}
      {canDelete && (
        <div className="border-t border-red-200 pt-3 mt-3 bg-red-50/30 -mx-4 px-4 pb-3 rounded-b-lg">
          <p className="text-xs font-bold text-red-700 mb-2 uppercase tracking-wide">⚠ Zona Berbahaya</p>
          <div className="flex items-start gap-3 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              className="text-red-700 border-red-300 hover:bg-red-100 hover:text-red-800 hover:border-red-400"
            >
              <Trash2 className="w-3.5 h-3.5 mr-1.5" />
              {deleteMutation.isPending ? 'Menghapus...' : 'Hapus Kunjungan'}
            </Button>
            <p className="text-xs text-red-700/80 flex-1 min-w-[200px]">
              Menghapus data kunjungan + data konsultasi + evaluasi terkait.
              Audit log tetap tersimpan, tapi data utama <strong>tidak bisa di-undo</strong>.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

const expandStyle = document.createElement('style')
expandStyle.textContent = `
.animate-in { animation: expandIn 0.2s ease-out; }
@keyframes expandIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
`
if (!document.head.querySelector('[data-visit-log-anim]')) {
  expandStyle.setAttribute('data-visit-log-anim', '')
  document.head.appendChild(expandStyle)
}

export default function VisitLogPage() {
  const [filters, setFilters] = useState<VisitFilterState>({
    q: '',
    layanan: '',
    status: '',
    tahun: '',
    bulan: '',
  })
  const [debouncedFilters, setDebouncedFilters] = useState(filters)
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(10)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedFilters(filters)
      setPage(1)
    }, 400)
    return () => clearTimeout(t)
  }, [filters])

  const { data, isLoading } = useQuery({
    queryKey: ['visits', { ...debouncedFilters, page, limit }],
    queryFn: () =>
      visitsApi
        .list({
          q: debouncedFilters.q || undefined,
          layanan: debouncedFilters.layanan || undefined,
          status: debouncedFilters.status || undefined,
          tahun: debouncedFilters.tahun || undefined,
          bulan: debouncedFilters.bulan || undefined,
          page,
          limit,
        })
        .then(r => r.data),
  })

  const visits = data?.data ?? []
  const pagination = data?.pagination

  const toggleExpand = (id: number) => {
    setExpandedId(prev => (prev === id ? null : id))
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="admin-h1">Daftar Kunjungan</h1>
          <p className="admin-subtitle">Log semua kunjungan PST</p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            visitsApi.list({ ...debouncedFilters, limit: 10000 }).then(r => {
              exportCsv('log-kunjungan', r.data.data.map((v: Visit) => ({
                nama: v.nama, instansi: v.nama_instansi,
                layanan: parseLayanan(v.jenis_layanan).join('; '),
                sarana: parseSarana(v.sarana).map(saranaLabel).join('; '),
                tanggal: v.date_visit, status: v.status,
                nomor_antrian: v.nomor_antrian, rating: v.rating_pengunjung,
              })))
            }).catch(() => toast.error('Gagal mengekspor data'))
          }}
        >
          <Download className="w-4 h-4 mr-2" />
          Export CSV
        </Button>
      </div>

      <VisitFilters filters={filters} onChange={setFilters} />

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </div>
      ) : visits.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          Tidak ada data kunjungan ditemukan.
        </div>
      ) : (
        <div className="rounded-md border overflow-hidden">
          {/* Header */}
          <div className="grid grid-cols-[40px_1fr_1.5fr_1fr_120px_90px_40px] gap-2 px-4 py-2 bg-muted/50 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            <span>No</span>
            <span>Nama</span>
            <span>Layanan</span>
            <span>Sarana</span>
            <span>Tanggal</span>
            <span>Status</span>
            <span></span>
          </div>
          {visits.map((visit: Visit, idx: number) => (
            <div key={visit.id_kunjungan} className="border-t">
              {/* Row */}
              <div
                className="grid grid-cols-[40px_1fr_1.5fr_1fr_120px_90px_40px] gap-2 px-4 py-3 items-center cursor-pointer hover:bg-muted/30 transition-colors"
                onClick={() => toggleExpand(visit.id_kunjungan)}
              >
                <span className="text-sm text-muted-foreground">
                  {(page - 1) * limit + idx + 1}
                </span>
                <span className="text-sm font-medium truncate">{visit.nama}</span>
                <span className="flex flex-wrap gap-1">
                  {parseLayanan(visit.jenis_layanan).map((l, i) => (
                    <span key={i} className="inline-block px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 text-[11px] font-medium">{l}</span>
                  ))}
                </span>
                <span className="flex flex-wrap gap-1">
                  {parseSarana(visit.sarana).map((c, i) => (
                    <span key={i} className="inline-block px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 text-[11px] font-medium">{saranaLabel(c)}</span>
                  ))}
                  {!visit.sarana && <span className="text-xs text-muted-foreground">-</span>}
                </span>
                <span className="text-sm text-muted-foreground">{formatDate(visit.date_visit)}</span>
                <StatusBadge status={visit.status} />
                <span className="flex justify-end text-muted-foreground">
                  {expandedId === visit.id_kunjungan ? (
                    <ChevronUp className="w-4 h-4" />
                  ) : (
                    <ChevronDown className="w-4 h-4" />
                  )}
                </span>
              </div>

              {/* Expandable detail panel */}
              {expandedId === visit.id_kunjungan && (
                <div className="overflow-hidden animate-in">
                  <VisitDetailPanel visit={visit} />
                </div>
              )}
            </div>
          ))}
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
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(p => p - 1)}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="text-sm">
              {page} / {pagination.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pagination.totalPages}
              onClick={() => setPage(p => p + 1)}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
