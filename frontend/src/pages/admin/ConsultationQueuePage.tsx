import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { consultationsApi } from '@/api/consultations'
import { QueueList } from '@/components/admin/QueueList'
import { QueueCallButton } from '@/components/admin/QueueCallButton'
import { useAuth } from '@/providers/AuthProvider'
import { canFinalizeLayanan, parseLayananForRole, nextStatusAfterCompletion, needsQueueCall } from '@/lib/role-access'
import type { Visit } from '@/types/visit'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ExternalLink, Volume2, ClipboardList, ClipboardCheck, CheckCircle, Lock } from 'lucide-react'

export default function ConsultationQueuePage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const role = user?.role

  const { data: allVisits, isLoading } = useQuery({
    queryKey: ['consultations-queue'],
    queryFn: () => consultationsApi.list().then(r => r.data.data),
    refetchInterval: 30000,
  })

  // Petugas dengan scope spesifik hanya melihat visit yang relevan dengan rolenya.
  // Admin/superadmin/operator (legacy) melihat semua.
  const scopedRoles = role === 'petugas_pst' || role === 'resepsionis'
  const visits = scopedRoles
    ? (allVisits ?? []).filter((v: Visit) => canFinalizeLayanan(role, parseLayananForRole(v.jenis_layanan)))
    : (allVisits ?? [])

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
      const msg = e && typeof e === 'object' && 'response' in e
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? (e as any).response?.data?.message
        : null
      toast.error(msg || 'Gagal memperbarui status')
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

  const handleStart = async (visitId: number, currentStatus: string) => {
    if (currentStatus === 'antri' || currentStatus === 'dipanggil') {
      try {
        await consultationsApi.updateStatus(visitId, 'diproses')
        queryClient.invalidateQueries({ queryKey: ['consultations-queue'] })
      } catch {
        // Non-fatal: lanjut ke form meski transition gagal
      }
    }
    navigate(`/admin/consultations/${visitId}/form`)
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="admin-h1">Antrian PST</h1>
          <p className="admin-subtitle">4 layanan inti SKD: Perpustakaan, Konsultasi, Rekomendasi, Penjualan</p>
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

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      ) : (
        <QueueList
          visits={visits}
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
                  Mulai
                </Button>
              )}
              {visit.status === 'menunggu_evaluasi' && (
                <a
                  href="/kiosk/evaluasi"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Membuka Terminal Evaluasi (tab baru). Terminal melayani pengunjung sesuai URUTAN ANTRIAN — bukan khusus visit ini. Pengunjung mengonfirmasi identitasnya sendiri di layar sebelum mengisi."
                >
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-amber-700 hover:text-amber-800 hover:bg-amber-50 border-amber-300"
                  >
                    <ClipboardCheck className="w-3.5 h-3.5 mr-1" />
                    Terminal Evaluasi
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
      )}
    </div>
  )
}
