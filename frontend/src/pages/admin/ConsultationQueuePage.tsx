import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getApiErrorMessage } from '@/lib/apiError'
import { consultationsApi } from '@/api/consultations'
import { QueueList } from '@/components/admin/QueueList'
import { QueueCallButton } from '@/components/admin/QueueCallButton'
import { VisitFilters, type VisitFilterState } from '@/components/admin/VisitFilters'
import { useAuth } from '@/providers/AuthProvider'
import { canFinalizeLayanan, parseLayananForRole, nextStatusAfterCompletion, needsQueueCall, getActiveServiceGroup } from '@/lib/role-access'
import type { Visit } from '@/types/visit'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ExternalLink, Volume2, ClipboardList, ClipboardCheck, CheckCircle, Lock } from 'lucide-react'

export default function ConsultationQueuePage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const role = user?.role

  const [filters, setFilters] = useState<VisitFilterState>({
    q: '', layanan: '', status: '', tahun: '', bulan: '',
  })
  const [debounced, setDebounced] = useState(filters)
  const [page, setPage] = useState(1)
  const limit = 25

  useEffect(() => {
    const t = setTimeout(() => { setDebounced(filters); setPage(1) }, 400)
    return () => clearTimeout(t)
  }, [filters])

  const { data, isLoading } = useQuery({
    queryKey: ['consultations-queue', { ...debounced, page, limit }],
    queryFn: () =>
      consultationsApi
        .list({
          q: debounced.q || undefined,
          status: debounced.status || undefined,
          layanan: debounced.layanan || undefined,
          tahun: debounced.tahun || undefined,
          bulan: debounced.bulan || undefined,
          page,
          limit,
        })
        .then(r => r.data),
    refetchInterval: 30000,
  })

  // Role scoping kini dikerjakan backend (Consultations::index). Memfilter lagi
  // di sini akan merusak paginasi: halaman berisi 25 baris bisa menyisakan 3.
  const visits = data?.data ?? []
  const pagination = data?.pagination

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      consultationsApi.updateStatus(id, status),
    onSuccess: () => {
      toast.success('Status berhasil diperbarui')
      queryClient.invalidateQueries({ queryKey: ['consultations-queue'] })
    },
    onError: (e: unknown) => {
      // Surface backend message — backend bisa return 400 dengan pesan eksplisit
      // (mis. "Form konsultasi SKD belum lengkap. Isi minimal 1 baris...").
      toast.error(getApiErrorMessage(e, 'Gagal memperbarui status'))
    },
  })

  const handleTestSound = async () => {
    try {
      await consultationsApi.testSound(0)
      toast.success('Tes suara dikirim ke TV')
    } catch {
      toast.error('Gagal mengirim tes suara')
    }
  }

  const handleStart = async (visitId: number, currentStatus: string, jenisLayanan: string) => {
    if (currentStatus === 'antri' || currentStatus === 'dipanggil') {
      try {
        await consultationsApi.updateStatus(visitId, 'diproses')
        queryClient.invalidateQueries({ queryKey: ['consultations-queue'] })
      } catch {
        // Non-fatal: lanjut ke form meski transition gagal
      }
    }
    // Tiap grup menulis ke tabel berbeda: SKD -> konsultasi_pengunjung,
    // DTSEN -> dtsen_konsultasi. Salah rute = data tertulis ke tabel salah.
    // Resepsionis TIDAK ke form konsultasi karena ConsultationFormPage
    // mewajibkan >=1 baris kebutuhan_data, sedangkan gerbangnya hanya
    // menuntut keterangan — editornya ada di VisitLogPage.
    const group = getActiveServiceGroup(parseLayananForRole(jenisLayanan))
    if (group === 'DTSEN')            navigate(`/admin/dtsen/${visitId}/form`)
    else if (group === 'ONLINE')      navigate('/admin/layanan-online')
    else if (group === 'RESEPSIONIS') navigate('/admin/visits')
    else                              navigate(`/admin/consultations/${visitId}/form`)
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="admin-h1">Antrian PST — Semua Kunjungan</h1>
          <p className="admin-subtitle">Semua layanan, semua tanggal, semua kanal</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleTestSound}>
            <Volume2 className="w-4 h-4 mr-2" />
            Tes Suara ke TV
          </Button>
          <a
            href="https://dashboard-pst.bpsmalut.com"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button variant="outline">
              <ExternalLink className="w-4 h-4 mr-2" />
              Dashboard PST
            </Button>
          </a>
        </div>
      </div>

      <VisitFilters filters={filters} onChange={setFilters} />

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      ) : (
        <>
          <QueueList
            visits={visits}
            emptyMessage="Tidak ada kunjungan yang cocok dengan filter."
            renderActions={(visit: Visit) => (
              <>
                {needsQueueCall(parseLayananForRole(visit.jenis_layanan)) && (
                  <QueueCallButton
                    visitId={visit.id_kunjungan}
                    nomor_antrian={visit.nomor_antrian}
                  />
                )}
                {/* Sudah ada data konsultasi tersimpan → "Lihat / Edit", belum →
                    "Mulai". Tetap lewat handleStart supaya transisi antri/dipanggil
                    → diproses tidak hilang (hanya label/ikon yang berubah). */}
                {Number(visit.has_konsultasi) > 0 ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleStart(visit.id_kunjungan, visit.status, visit.jenis_layanan)}
                  >
                    <ClipboardCheck className="w-3.5 h-3.5 mr-1" />
                    Lihat / Edit
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleStart(visit.id_kunjungan, visit.status, visit.jenis_layanan)}
                  >
                    <ClipboardList className="w-3.5 h-3.5 mr-1" />
                    Mulai
                  </Button>
                )}
                {visit.status === 'menunggu_evaluasi' && (
                  <a
                    href={`/kiosk/evaluasi/${visit.id_kunjungan}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Buka form evaluasi untuk pengunjung INI di tab baru. Pengunjung mengonfirmasi identitasnya di layar sebelum mengisi."
                  >
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-amber-700 hover:text-amber-800 hover:bg-amber-50 border-amber-300"
                    >
                      <ClipboardCheck className="w-3.5 h-3.5 mr-1" />
                      Buka Evaluasi
                    </Button>
                  </a>
                )}
                {visit.status !== 'selesai' && visit.status !== 'menunggu_evaluasi' && (
                  canFinalizeLayanan(role, parseLayananForRole(visit.jenis_layanan)) ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-green-700 hover:text-green-800 hover:bg-green-50"
                      onClick={() =>
                        statusMutation.mutate({
                          id: visit.id_kunjungan,
                          status: nextStatusAfterCompletion(parseLayananForRole(visit.jenis_layanan)),
                        })
                      }
                      disabled={statusMutation.isPending}
                      title={
                        nextStatusAfterCompletion(parseLayananForRole(visit.jenis_layanan)) === 'selesai'
                          ? 'Selesai langsung tanpa evaluasi'
                          : 'Lanjut ke tablet evaluasi'
                      }
                    >
                      <CheckCircle className="w-3.5 h-3.5 mr-1" />
                      Selesai
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-gray-400 cursor-not-allowed"
                      disabled
                      title="Layanan ini di luar kewenangan role Anda"
                    >
                      <Lock className="w-3.5 h-3.5 mr-1" />
                      Selesai
                    </Button>
                  )
                )}
              </>
            )}
          />
          {pagination && pagination.totalPages > 1 && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">
                Halaman {pagination.page} dari {pagination.totalPages} — {pagination.total} kunjungan
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1}
                        onClick={() => setPage(p => p - 1)}>Sebelumnya</Button>
                <Button variant="outline" size="sm" disabled={page >= pagination.totalPages}
                        onClick={() => setPage(p => p + 1)}>Berikutnya</Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
