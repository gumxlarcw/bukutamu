import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { guestsApi } from '@/api/guests'
import { VisitorForm } from '@/components/kiosk/VisitorForm'
import type { GuestFormData } from '@/types/guest'
import { Button } from '@/components/ui/button'
import { ArrowLeft } from 'lucide-react'

const EMPTY_FORM: GuestFormData = {
  tgldatang: '',
  nama: '',
  email: '',
  notel: '',
  jeniskelamin: 'Laki-laki',
  umur: 0,
  disabilitas: 0,
  jenis_disabilitas: 0,
  pendidikan: 0,
  pekerjaan: 0,
  pekerjaan_lainnya: '',
  kategori_instansi: 0,
  kategori_lainnya: '',
  nama_instansi: '',
  pemanfaatan: 0,
  pemanfaatan_lainnya: '',
  pengaduan: 'Tidak',
}

export default function GuestAddPage() {
  const navigate = useNavigate()
  const [formData, setFormData] = useState<GuestFormData>(EMPTY_FORM)

  const isValid =
    formData.nama.trim() !== '' &&
    formData.email.trim() !== '' &&
    formData.notel.trim() !== '' &&
    formData.pendidikan > 0 &&
    formData.pekerjaan > 0 &&
    formData.kategori_instansi > 0 &&
    formData.nama_instansi.trim() !== '' &&
    formData.pemanfaatan > 0

  const qc = useQueryClient()

  const createMutation = useMutation({
    mutationFn: () => guestsApi.create(formData),
    onSuccess: () => {
      // Tanpa invalidasi, daftar tujuan menampilkan snapshot SEBELUM create.
      // QueryProvider memasang staleTime 30 detik DAN refetchOnWindowFocus false,
      // jadi begitu daftar ter-render basi tidak ada yang menjadwalkan refetch —
      // salah terus sampai operator ganti filter/halaman atau reload.
      // AUDIT_2026-08-01 #19.
      qc.invalidateQueries({ queryKey: ['guests'] })
      toast.success('Tamu berhasil ditambahkan')
      navigate('/admin/guests')
    },
    onError: () => toast.error('Gagal menambahkan tamu'),
  })

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate('/admin/guests')}
        >
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="admin-h1">Tambah Tamu Baru</h1>
          <p className="admin-subtitle">Isi data pengunjung secara manual</p>
        </div>
      </div>

      <div className="admin-card p-6">
          <h2 className="text-base font-bold mb-4 text-[--admin-text]">Data Pengunjung</h2>
          <div className="admin-form-wrap">
            <VisitorForm value={formData} onChange={setFormData} />
          </div>

          <div className="mt-6 flex justify-end gap-3">
            <Button variant="outline" onClick={() => navigate('/admin/guests')}>
              Batal
            </Button>
            <Button
              className="bg-orange-600 hover:bg-orange-700 text-white"
              disabled={!isValid || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? 'Menyimpan...' : 'Simpan Tamu'}
            </Button>
          </div>
      </div>
    </div>
  )
}
