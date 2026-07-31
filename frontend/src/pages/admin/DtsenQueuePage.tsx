import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { VisitFilters, type VisitFilterState } from '@/components/admin/VisitFilters'
import { toast } from 'sonner'
import { getApiErrorMessage } from '@/lib/apiError'
import { dtsenApi } from '@/api/dtsen'
import { consultationsApi } from '@/api/consultations'
import { QueueList } from '@/components/admin/QueueList'
import { QueueCallButton } from '@/components/admin/QueueCallButton'
import { useAuth } from '@/providers/AuthProvider'
import { canFinalizeLayanan, parseLayananForRole, nextStatusAfterCompletion, needsQueueCall } from '@/lib/role-access'
import type { Visit } from '@/types/visit'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ExternalLink, Volume2, ClipboardList, ClipboardCheck, CheckCircle, Lock } from 'lucide-react'

export default function DtsenQueuePage() {
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
    queryKey: ['dtsen-queue', { ...debounced, page, limit }],
    queryFn: () =>
      dtsenApi
        .list({
          q: debounced.q || undefined,
          status: debounced.status || undefined,
          tahun: debounced.tahun || undefined,
          bulan: debounced.bulan || undefined,
          page,
          limit,
        })
        .then(r => r.data),
    refetchInterval: 30000,
  })

  // Role scoping kini dikerjakan backend (Dtsen::index). Memfilter lagi di sini
  // akan merusak paginasi: halaman berisi 25 baris bisa menyisakan 3.
  const visits = data?.data ?? []
  const pagination = data?.pagination

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      dtsenApi.updateStatus(id, status),
    onSuccess: () => {
      toast.success('Status berhasil diperbarui')
      queryClient.invalidateQueries({ queryKey: ['dtsen-queue'] })
    },
    onError: (e: unknown) => {
      // Surface backend message untuk pesan "Form DTSEN belum diisi..." yang explicit.
      toast.error(getApiErrorMessage(e, 'Gagal memperbarui status'))
    },
  })

  // Reuse endpoint test-sound dari consultations — kirim TES ke dashboard TV (universal).
  const handleTestSound = async () => {
    try {
      await consultationsApi.testSound(0)
      toast.success('Tes suara dikirim ke TV')
    } catch {
      toast.error('Gagal mengirim tes suara')
    }
  }

  const handleStart = async (visitId: number, currentStatus: string) => {
    if (currentStatus === 'antri' || currentStatus === 'dipanggil') {
      try {
        await dtsenApi.updateStatus(visitId, 'diproses')
        queryClient.invalidateQueries({ queryKey: ['dtsen-queue'] })
      } catch {
        // Non-fatal — tetap lanjut ke form
      }
    }
    navigate(`/admin/dtsen/${visitId}/form`)
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="admin-h1">Antrian Konsultasi DTSEN</h1>
          <p className="admin-subtitle">Konsultasi Data Terpadu Sosial Ekonomi Nasional — semua tanggal</p>
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

      {/* Array kosong menyembunyikan dropdown Layanan: halaman ini terkunci ke
          Konsultasi DTSEN, jadi filter itu tidak punya arti. */}
      <VisitFilters filters={filters} onChange={setFilters} layananOptions={[]} />

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      ) : (
        <QueueList
          emptyMessage="Tidak ada kunjungan DTSEN yang cocok dengan filter."
          visits={visits}
          renderActions={(visit: Visit) => (
            <>
              {needsQueueCall(parseLayananForRole(visit.jenis_layanan)) && (
                <QueueCallButton
                  visitId={visit.id_kunjungan}
                  nomor_antrian={visit.nomor_antrian}
                />
              )}
              {/* Sudah ada data DTSEN tersimpan → "Lihat / Edit", belum → "Form
                  DTSEN". Tetap lewat handleStart (transisi antri → diproses). */}
              {Number(visit.has_konsultasi) > 0 ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleStart(visit.id_kunjungan, visit.status)}
                >
                  <ClipboardCheck className="w-3.5 h-3.5 mr-1" />
                  Lihat / Edit
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleStart(visit.id_kunjungan, visit.status)}
                >
                  <ClipboardList className="w-3.5 h-3.5 mr-1" />
                  Form DTSEN
                </Button>
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
                    title="Selesai langsung tanpa evaluasi (DTSEN skip SKD)"
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
      )}

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
    </div>
  )
}
