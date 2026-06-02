import { useState, useEffect, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { consultationsApi } from '@/api/consultations'
import { visitsApi } from '@/api/visits'
import { ConsultationDataForm } from '@/components/admin/ConsultationDataForm'
import { parseLayanan, type ConsultationDataRow } from '@/types/visit'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { ArrowLeft, Save, AlertTriangle } from 'lucide-react'

// CodeIgniter (mysqli) mengembalikan kolom numerik sebagai STRING (mis.
// status_data:"4"). Form ini membandingkan dengan === number (PillRadio,
// showSumberData di ConsultationDataForm), jadi nilai string tidak match → pill
// "Belum Diperoleh" tidak ke-highlight & blok "Detail Sumber Data" tidak muncul
// saat data dibuka lagi. Koersi balik ke number di boundary sebelum masuk state
// (VisitLogPage sudah melakukan Number()-coerce yang sama).
function numOrNull(v: unknown): number | null {
  return v === null || v === undefined || v === '' ? null : Number(v)
}

function normalizeConsultationRow(r: ConsultationDataRow): ConsultationDataRow {
  return {
    ...r,
    status_data: (numOrNull(r.status_data) ?? r.status_data) as number,
    level_data: numOrNull(r.level_data),
    periode_data: numOrNull(r.periode_data),
    tahun_awal: numOrNull(r.tahun_awal),
    tahun_akhir: numOrNull(r.tahun_akhir),
    tahun_publikasi: numOrNull(r.tahun_publikasi),
    digunakan_nasional: numOrNull(r.digunakan_nasional),
  }
}

export default function ConsultationFormPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const visitId = Number(id)

  const [rows, setRows] = useState<ConsultationDataRow[]>([])
  const [hasilKonsultasi, setHasilKonsultasi] = useState('')
  // Guard: hidrasi form dari data tersimpan hanya SEKALI per load visit, supaya
  // refetch latar (interval/mount/invalidate) tidak menimpa editan yang sedang
  // diketik petugas. Di-reset saat visitId berubah.
  const hydratedRef = useRef(false)

  // Fetch visit info — backend Visits::detail() membungkus dengan { visit, consultation, evaluation }
  const { data: visit, isLoading: visitLoading } = useQuery({
    queryKey: ['visit', visitId],
    queryFn: () =>
      visitsApi.get(visitId).then(r => {
        const payload = r.data.data as unknown
        if (payload && typeof payload === 'object' && 'visit' in payload) {
          return (payload as { visit: typeof r.data.data }).visit
        }
        return r.data.data
      }),
    enabled: !!visitId,
  })

  // Fetch existing consultation data
  const { data: existingData, isLoading: dataLoading } = useQuery({
    queryKey: ['consultation-data', visitId],
    queryFn: () => consultationsApi.getData(visitId).then(r => r.data.data),
    enabled: !!visitId,
  })

  // Reset hydration guard ketika pindah visit (route param berubah).
  useEffect(() => {
    hydratedRef.current = false
  }, [visitId])

  // Populate form with existing data, atau auto-add 1 row kosong jika fresh load.
  useEffect(() => {
    if (!existingData) return
    if (existingData.length > 0) {
      if (!hydratedRef.current) {
        setRows(existingData.map(normalizeConsultationRow))
        // hasil_konsultasi disimpan denormalized di tiap baris. Ambil dari baris
        // pertama yang punya rincian_data nyata supaya "ghost row" ringkasan
        // resepsionis (rincian NULL via Visits::summary) tidak menimpa textarea
        // SKD dengan catatan asing. Kalau tak ada baris nyata → biarkan kosong.
        const note = existingData.find(r => (r.rincian_data ?? '').trim() !== '')?.hasil_konsultasi
        setHasilKonsultasi(note ?? '')
        hydratedRef.current = true
      }
    } else if (rows.length === 0) {
      setRows([
        {
          rincian_data: '',
          wilayah_data: '',
          tahun_awal: new Date().getFullYear(),
          tahun_akhir: new Date().getFullYear(),
          level_data: 1,
          periode_data: 4,
          status_data: 4,
          jenis_publikasi: null,
          judul_publikasi: null,
          tahun_publikasi: null,
          digunakan_nasional: null,
          kualitas: null,
        },
      ])
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingData])

  const saveMutation = useMutation({
    mutationFn: () =>
      consultationsApi.saveData(visitId, {
        kebutuhan_data: rows,
        hasil_konsultasi: hasilKonsultasi || undefined,
      }),
    onSuccess: () => {
      // Refresh antrian: simpan men-transisi status (mis. → menunggu_evaluasi),
      // jadi cache list harus di-invalidate supaya tombol "Buka Evaluasi" &
      // label "Lihat/Edit" langsung muncul tanpa nunggu refetchInterval 30s.
      // Hanya key antrian — JANGAN ['consultation-data'/'visit'] (di-share dengan
      // VisitLogPage; invalidate-nya cuma nambah coupling tanpa manfaat di sini).
      queryClient.invalidateQueries({ queryKey: ['consultations-queue'] })
      toast.success('Data konsultasi berhasil disimpan')
      navigate('/admin/consultations')
    },
    onError: (e: unknown) => {
      const msg = e && typeof e === 'object' && 'response' in e
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? (e as any).response?.data?.message
        : null
      toast.error(msg || 'Gagal menyimpan data konsultasi')
    },
  })

  // Form-lengkap gate: cermin backend Consultations::data validation.
  // Wajib: ≥1 baris kebutuhan_data dengan rincian_data terisi + ringkasan/hasil non-empty.
  // Catatan: ringkasan bukan harus berisi data yang sudah diperoleh — kalau data masih
  // pending, petugas bisa tulis "Permintaan akan diteruskan ke unit X / dikirim via email".
  const validRows = rows.filter(r => (r.rincian_data ?? '').trim() !== '')
  const hasilFilled = hasilKonsultasi.trim() !== ''
  const formIncomplete = validRows.length === 0 || !hasilFilled
  const missingReasons: string[] = []
  if (validRows.length === 0) missingReasons.push('isi minimal 1 baris kebutuhan data dengan rincian yang diminta tamu')
  if (!hasilFilled) missingReasons.push('isi ringkasan / hasil konsultasi (boleh berupa catatan tindak lanjut kalau data belum diperoleh)')

  const isLoading = visitLoading || dataLoading

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate('/admin/consultations')}
        >
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="admin-h1">Form Konsultasi</h1>
          <p className="admin-subtitle">Catat kebutuhan data pengunjung</p>
        </div>
      </div>

      {/* Visitor info */}
      <div className="admin-card p-6">
          <h2 className="text-base font-bold mb-3">Informasi Pengunjung</h2>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-4 w-64" />
            </div>
          ) : visit ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
              <div>
                <p className="text-muted-foreground">Nama</p>
                <p className="font-semibold">{visit.nama}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Instansi</p>
                <p className="font-semibold">{visit.nama_instansi}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Layanan</p>
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {parseLayanan(visit.jenis_layanan).map((l, i) => (
                    <span key={i} className="px-2 py-0.5 rounded bg-orange-100 text-orange-700 text-xs font-medium">{l}</span>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-muted-foreground">No. Antrian</p>
                <p className="font-semibold">{visit.nomor_antrian ?? '-'}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Status</p>
                <StatusBadge status={visit.status} />
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">Data pengunjung tidak ditemukan.</p>
          )}
      </div>

      {/* Consultation data form */}
      <div className="admin-card p-6">
          <h2 className="text-base font-bold mb-3">Kebutuhan Data</h2>
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-32 rounded-xl" />
              <Skeleton className="h-32 rounded-xl" />
            </div>
          ) : (
            <ConsultationDataForm
              rows={rows}
              hasilKonsultasi={hasilKonsultasi}
              kategoriInstansi={(visit as { kategori_instansi?: number | string } | undefined)?.kategori_instansi ?? null}
              onChange={setRows}
              onHasilChange={setHasilKonsultasi}
            />
          )}
      </div>

      {/* Form-incomplete warning */}
      {!isLoading && formIncomplete && (
        <div className="flex items-start gap-2 px-4 py-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <strong>Form belum lengkap.</strong> Sebelum simpan, {missingReasons.join(' dan ')}.
          </div>
        </div>
      )}

      {/* Save button */}
      <div className="flex justify-end gap-3 pb-6">
        <Button variant="outline" onClick={() => navigate('/admin/consultations')}>
          Batal
        </Button>
        <Button
          className="bg-orange-600 hover:bg-orange-700 text-white"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending || formIncomplete}
          title={formIncomplete ? `Lengkapi dulu: ${missingReasons.join('; ')}` : undefined}
        >
          <Save className="w-4 h-4 mr-2" />
          {saveMutation.isPending ? 'Menyimpan...' : 'Simpan Data'}
        </Button>
      </div>
    </div>
  )
}
