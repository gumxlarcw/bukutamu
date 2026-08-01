import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { guestsApi } from '@/api/guests'
import { visitsApi } from '@/api/visits'
import { ManualEntryForm } from '@/components/admin/ManualEntryForm'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ArrowLeft, PlusCircle } from 'lucide-react'

export default function ManualEntryPage() {
  const navigate = useNavigate()
  const [selectedGuestId, setSelectedGuestId] = useState<number | null>(null)
  const [selectedServices, setSelectedServices] = useState<string[]>([])
  const [layananLainnya, setLayananLainnya] = useState('')
  const [selectedSarana, setSelectedSarana] = useState<number[]>([])
  const [saranaLainnya, setSaranaLainnya] = useState('')
  const qc = useQueryClient()

  const { data: guestsData, isLoading: guestsLoading } = useQuery({
    // ['guests','all'] BUKAN ['guests-all']: react-query mencocokkan queryKey per
    // ELEMEN, jadi invalidateQueries({queryKey:['guests']}) tidak akan pernah
    // menjangkau string tunggal 'guests-all'. AUDIT_2026-08-01 #19.
    queryKey: ['guests', 'all'],
    queryFn: () => guestsApi.list({ limit: 1000 }).then(r => r.data.data),
  })

  const guests = guestsData ?? []

  const createMutation = useMutation({
    mutationFn: () =>
      visitsApi.create({
        id_user: selectedGuestId!,
        jenis_layanan: selectedServices,
        layanan_lainnya: layananLainnya || undefined,
        sarana: selectedSarana,
        sarana_lainnya: saranaLainnya || undefined,
      }),
    onSuccess: () => {
      // Lihat catatan di GuestAddPage — tanpa ini Daftar Kunjungan menampilkan
      // snapshot pra-create sampai operator mengubah filter. Konsekuensi nyata:
      // entri manual ganda. AUDIT_2026-08-01 #19.
      qc.invalidateQueries({ queryKey: ['visits'] })
      toast.success('Kunjungan manual berhasil ditambahkan')
      navigate('/admin/visits')
    },
    onError: () => toast.error('Gagal menambahkan kunjungan'),
  })

  const isValid =
    selectedGuestId !== null &&
    selectedServices.length > 0 &&
    (!selectedServices.includes('Lainnya') || layananLainnya.trim() !== '') &&
    selectedSarana.length > 0 &&
    (!selectedSarana.includes(32) || saranaLainnya.trim() !== '')

  return (
    <div className="max-w-2xl space-y-5">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => navigate('/admin/visits')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="admin-h1">Tambah Kunjungan Manual</h1>
          <p className="admin-subtitle">Daftarkan pengunjung secara manual</p>
        </div>
      </div>

      <div className="admin-card p-6">
        <h2 className="text-base font-bold mb-3">Form Kunjungan</h2>
        {guestsLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 rounded-md" />
            <Skeleton className="h-10 rounded-md" />
            <Skeleton className="h-10 rounded-md" />
          </div>
        ) : (
          <ManualEntryForm
            guests={guests}
            selectedGuestId={selectedGuestId}
            selectedServices={selectedServices}
            layananLainnya={layananLainnya}
            selectedSarana={selectedSarana}
            saranaLainnya={saranaLainnya}
            onGuestChange={setSelectedGuestId}
            onServicesChange={setSelectedServices}
            onLayananLainnyaChange={setLayananLainnya}
            onSaranaChange={setSelectedSarana}
            onSaranaLainnyaChange={setSaranaLainnya}
          />
        )}

        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" onClick={() => navigate('/admin/visits')}>
            Batal
          </Button>
          <Button
            className="bg-orange-600 hover:bg-orange-700 text-white"
            disabled={!isValid || createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            <PlusCircle className="w-4 h-4 mr-2" />
            {createMutation.isPending ? 'Mendaftarkan...' : 'Daftarkan Kunjungan'}
          </Button>
        </div>
      </div>
    </div>
  )
}
