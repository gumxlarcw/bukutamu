import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { dtsenApi } from '@/api/dtsen'
import { visitsApi } from '@/api/visits'
import { DtsenDataForm } from '@/components/admin/DtsenDataForm'
import { parseLayanan, type DtsenDataRow } from '@/types/visit'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { ArrowLeft, Save } from 'lucide-react'

export default function DtsenFormPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const visitId = Number(id)

  const [form, setForm] = useState<Partial<DtsenDataRow>>({
    jenis_konsultasi_dtsen: undefined,
    hasil: undefined,
    catatan: null,
    nik_dirujuk: null,
  })

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

  const { data: existing, isLoading: dataLoading } = useQuery({
    queryKey: ['dtsen-data', visitId],
    queryFn: () => dtsenApi.getData(visitId).then(r => r.data.data),
    enabled: !!visitId,
  })

  useEffect(() => {
    if (existing) {
      // Hydrate the editable form once the saved DTSEN row loads. Legitimate
      // async-data → local-state sync (form then diverges as the user edits),
      // not a derivable value — the one extra render is acceptable here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setForm({
        jenis_konsultasi_dtsen: existing.jenis_konsultasi_dtsen,
        hasil: existing.hasil,
        catatan: existing.catatan,
        nik_dirujuk: existing.nik_dirujuk,
      })
    }
  }, [existing])

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!form.jenis_konsultasi_dtsen || !form.hasil || !form.catatan?.trim()) {
        throw new Error('Lengkapi field wajib')
      }
      return dtsenApi.saveData(visitId, {
        jenis_konsultasi_dtsen: form.jenis_konsultasi_dtsen,
        hasil: form.hasil,
        catatan: form.catatan,
        nik_dirujuk: form.nik_dirujuk ?? null,
      })
    },
    onSuccess: () => {
      // Parity dengan SKD: simpan men-transisi DTSEN langsung ke 'selesai', jadi
      // invalidate cache antrian supaya status & label langsung ter-refresh.
      queryClient.invalidateQueries({ queryKey: ['dtsen-queue'] })
      toast.success('Data DTSEN tersimpan, kunjungan diselesaikan.')
      navigate('/admin/dtsen')
    },
    onError: (e: Error) => toast.error(e.message || 'Gagal menyimpan data DTSEN'),
  })

  const isLoadingPage = visitLoading || dataLoading
  const isValid =
    !!form.jenis_konsultasi_dtsen &&
    !!form.hasil &&
    !!form.catatan?.trim()

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => navigate('/admin/dtsen')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="admin-h1">Form Konsultasi DTSEN</h1>
          <p className="admin-subtitle">Catat hasil konsultasi DTSEN</p>
        </div>
      </div>

      <div className="admin-card p-6">
        <h2 className="text-base font-bold mb-3">Informasi Pengunjung</h2>
        {isLoadingPage ? (
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

      <div className="admin-card p-6">
        <h2 className="text-base font-bold mb-3">Data Konsultasi DTSEN</h2>
        {isLoadingPage ? (
          <div className="space-y-3">
            <Skeleton className="h-10 rounded-md" />
            <Skeleton className="h-10 rounded-md" />
            <Skeleton className="h-32 rounded-md" />
          </div>
        ) : (
          <DtsenDataForm value={form} onChange={setForm} />
        )}
      </div>

      <div className="flex justify-end gap-3 pb-6">
        <Button variant="outline" onClick={() => navigate('/admin/dtsen')}>
          Batal
        </Button>
        <Button
          className="bg-orange-600 hover:bg-orange-700 text-white"
          onClick={() => saveMutation.mutate()}
          disabled={!isValid || saveMutation.isPending}
        >
          <Save className="w-4 h-4 mr-2" />
          {saveMutation.isPending ? 'Menyimpan...' : 'Simpan & Selesaikan'}
        </Button>
      </div>
    </div>
  )
}
