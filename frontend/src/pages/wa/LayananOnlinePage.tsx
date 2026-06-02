import { useState, useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { waApi } from '@/api/wa'
import { VisitorForm } from '@/components/kiosk/VisitorForm'
import { PermintaanDataForm, emptyPermintaanRow } from '@/components/wa/PermintaanDataForm'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import type { GuestFormData } from '@/types/guest'
import type { WaPermintaanRow } from '@/types/wa'

function blankGuest(phone: string): GuestFormData {
  return {
    tgldatang: '', nama: '', email: '', notel: phone, jeniskelamin: 'Laki-laki',
    umur: 0, disabilitas: 2, jenis_disabilitas: 0, pendidikan: 0, pekerjaan: 0,
    pekerjaan_lainnya: '', kategori_instansi: 0, kategori_lainnya: '',
    nama_instansi: '', pemanfaatan: 0, pemanfaatan_lainnya: '', pengaduan: 'Tidak',
  }
}

export default function LayananOnlinePage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const [params] = useSearchParams()
  const token = params.get('t') ?? ''

  const { data: prefill, isLoading, isError } = useQuery({
    queryKey: ['wa-session', sessionId, token],
    queryFn: () => waApi.getSession(Number(sessionId), token).then(r => r.data.data),
    enabled: !!sessionId && !!token,
    retry: false,
  })

  const initialGuest = useMemo<GuestFormData>(() => {
    const phone = prefill?.phone ?? ''
    const g = prefill?.guest
    if (!g) return blankGuest(phone)
    return {
      ...blankGuest(phone),
      nama: g.nama ?? '', email: g.email ?? '', jeniskelamin: (g.jeniskelamin as GuestFormData['jeniskelamin']) || 'Laki-laki',
      umur: g.umur ?? 0, pendidikan: g.pendidikan ?? 0, pekerjaan: g.pekerjaan ?? 0,
      kategori_instansi: g.kategori_instansi ?? 0, nama_instansi: g.nama_instansi ?? '', pemanfaatan: g.pemanfaatan ?? 0,
    }
  }, [prefill])

  const [guest, setGuest] = useState<GuestFormData | null>(null)
  const [rows, setRows] = useState<WaPermintaanRow[]>([emptyPermintaanRow()])
  const [ticket, setTicket] = useState<string | null>(null)
  const effGuest = guest ?? initialGuest

  const submit = useMutation({
    mutationFn: () =>
      waApi.submitSession(Number(sessionId), token, { ...effGuest, permintaan: rows }).then(r => r.data.data),
    onSuccess: (d) => setTicket(d?.ticket ?? null),
    onError: (e: unknown) => {
      const msg = e && typeof e === 'object' && 'response' in e
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? (e as any).response?.data?.message : null
      toast.error(msg || 'Gagal mengirim permintaan')
    },
  })

  if (!token) return <p className="p-8 text-center">Tautan tidak valid.</p>
  if (isLoading) return <LoadingSpinner className="min-h-screen" />
  if (isError || !prefill) return <p className="p-8 text-center">Tautan kedaluwarsa atau tidak valid. Silakan kirim pesan ulang ke WhatsApp layanan.</p>
  if (prefill.state === 'submitted' || ticket) {
    return (
      <div className="max-w-md mx-auto p-8 text-center space-y-2">
        <h1 className="text-xl font-bold">Permintaan terkirim ✅</h1>
        <p>Nomor tiket Anda: <b>{ticket ?? `WA-${prefill.session_id}`}</b></p>
        <p className="text-sm text-muted-foreground">Akan kami proses pada jam operasional layanan (Senin–Jumat 08.00–15.30 WIT).</p>
      </div>
    )
  }

  const canSubmit = effGuest.nama.trim() !== '' && rows.some(r => r.rincian_data.trim() !== '')

  return (
    <div className="max-w-md mx-auto p-4 space-y-6">
      <header className="text-center">
        <h1 className="text-lg font-bold">Layanan Data BPS Maluku Utara</h1>
        <p className="text-sm text-muted-foreground">Lengkapi data berikut untuk kami proses.</p>
        {prefill.multi_match && (
          <p className="text-xs text-amber-600 mt-1">Beberapa profil terkait nomor ini — petugas akan memverifikasi.</p>
        )}
      </header>

      <section>
        <h2 className="font-semibold mb-2">A. Identitas</h2>
        <VisitorForm value={effGuest} onChange={setGuest} />
      </section>

      <section>
        <h2 className="font-semibold mb-2">B. Permintaan Data</h2>
        <PermintaanDataForm rows={rows} onChange={setRows} />
      </section>

      <Button className="w-full" disabled={!canSubmit || submit.isPending} onClick={() => submit.mutate()}>
        {submit.isPending ? 'Mengirim…' : 'Kirim Permintaan'}
      </Button>
    </div>
  )
}
