import { useState, useMemo, useEffect, useRef } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CheckCircle2 } from 'lucide-react'
import { waApi } from '@/api/wa'
import { VisitorForm } from '@/components/kiosk/VisitorForm'
import { PermintaanDataForm, emptyPermintaanRow, permintaanRowsValid } from '@/components/wa/PermintaanDataForm'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import type { GuestFormData } from '@/types/guest'
import type { WaPermintaanRow } from '@/types/wa'

/** Efek angka/teks "scramble" seperti tiket antrian kiosk. */
function CountUp({ text }: { text: string }) {
  const [display, setDisplay] = useState('')
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    let step = 0
    const id = setInterval(() => {
      setDisplay(text.split('').map((c, i) => (i <= step ? c : chars[Math.floor(Math.random() * chars.length)])).join(''))
      step++
      if (step >= text.length) clearInterval(id)
    }, 55)
    return () => clearInterval(id)
  }, [text])
  return <>{display || text}</>
}

/** Layar sukses bergaya tiket (meniru QueueTicket kiosk offline). */
function SuccessTicket({ ticket }: { ticket: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'linear-gradient(160deg,#fff7ed,#ffe7cc)' }}>
      <style>{`
        .wa-tk { animation: waTkPop .55s cubic-bezier(.16,1,.3,1); }
        @keyframes waTkPop { from {opacity:0; transform:scale(.92) translateY(20px);} to {opacity:1; transform:scale(1) translateY(0);} }
        .wa-tk-glow { animation: waTkGlow 2s ease-in-out infinite alternate; }
        @keyframes waTkGlow { from {box-shadow:0 0 20px rgba(196,87,10,.14);} to {box-shadow:0 0 42px rgba(196,87,10,.30);} }
      `}</style>
      <div className="wa-tk relative bg-white rounded-2xl shadow-2xl px-6 py-7 max-w-sm w-full text-center overflow-hidden">
        {/* notch tiket kiri/kanan */}
        <span className="absolute -left-3 top-[46%] w-6 h-6 rounded-full" style={{ background: '#ffe7cc' }} />
        <span className="absolute -right-3 top-[46%] w-6 h-6 rounded-full" style={{ background: '#ffe7cc' }} />

        <div className="w-14 h-14 mx-auto rounded-full bg-emerald-100 grid place-items-center mb-3">
          <CheckCircle2 className="w-8 h-8 text-emerald-600" />
        </div>
        <p className="text-orange-600 font-semibold text-xs uppercase tracking-[0.2em]">Permintaan Diterima</p>
        <h2 className="text-base font-bold text-gray-900 mb-4">BPS Provinsi Maluku Utara</h2>

        <div className="wa-tk-glow bg-orange-50 border-2 border-orange-200 rounded-xl py-4 px-3 mb-4">
          <p className="text-orange-600 text-[11px] font-semibold mb-1 uppercase tracking-wide">Nomor Tiket</p>
          <p className="text-5xl font-black text-orange-600 leading-none tracking-tight font-mono"><CountUp text={ticket} /></p>
        </div>

        <p className="text-sm text-gray-600 leading-relaxed">
          Terima kasih, permintaan data Anda telah kami terima dan masuk antrian layanan online.
        </p>
        <p className="text-xs text-gray-500 mt-2 leading-relaxed">
          Akan diproses pada jam operasional layanan<br />Senin–Jumat, 08.00–15.30 WIT.
        </p>
        <div className="mt-4 text-[11px] text-gray-400 border-t border-dashed border-gray-300 pt-3">
          Simpan / screenshot tiket ini sebagai bukti permintaan Anda.
        </div>
      </div>
    </div>
  )
}

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

  // Identitas hanya boleh dari DB (match nomor HP). known = nomor cocok unik di DB.
  const known = !!prefill?.guest && !prefill?.multi_match

  const [guest, setGuest] = useState<GuestFormData | null>(null)
  const [rows, setRows] = useState<WaPermintaanRow[]>([emptyPermintaanRow()])
  const [ticket, setTicket] = useState<string | null>(null)
  const [step, setStep] = useState<1 | 2>(1)         // 1 = Data Diri, 2 = Data yang Dibutuhkan
  const [editProfile, setEditProfile] = useState(false) // true → user memilih "Perbarui Profil"
  const effGuest = guest ?? initialGuest

  const submit = useMutation({
    mutationFn: () =>
      waApi.submitSession(Number(sessionId), token, { ...effGuest, permintaan: rows, update_profile: editProfile }).then(r => r.data.data),
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
    return <SuccessTicket ticket={ticket ?? `WA-${prefill.session_id}`} />
  }

  const namaOk = effGuest.nama.trim() !== ''
  const permintaanOk = rows.some(r => r.rincian_data.trim() !== '')
  const yearsOk = permintaanRowsValid(rows)   // tahun_akhir ≥ tahun_awal & format wajar

  return (
    <div className="max-w-md mx-auto p-4 space-y-6">
      <header className="text-center space-y-2">
        <h1 className="text-lg font-bold">Layanan Data BPS Maluku Utara</h1>
        <p className="text-sm text-muted-foreground">
          Langkah {step} dari 2 — {step === 1 ? 'Data Diri' : 'Data yang Dibutuhkan'}
        </p>
        <div className="flex gap-1.5 justify-center">
          <span className={`h-1.5 w-12 rounded-full transition-colors ${step >= 1 ? 'bg-primary' : 'bg-muted'}`} />
          <span className={`h-1.5 w-12 rounded-full transition-colors ${step >= 2 ? 'bg-primary' : 'bg-muted'}`} />
        </div>
      </header>

      {/* ── Langkah 1 — Data Diri ── */}
      {step === 1 && (
        <section className="space-y-4">
          <h2 className="font-semibold">A. Data Diri</h2>

          {known && !editProfile ? (
            <>
              <div className="rounded-lg border p-4 space-y-1 bg-muted/30">
                <p className="font-medium text-base">{effGuest.nama || '—'}</p>
                {effGuest.nama_instansi && <p className="text-sm text-muted-foreground">{effGuest.nama_instansi}</p>}
                <p className="text-xs text-muted-foreground pt-1">
                  Data Anda sudah kami miliki dari kunjungan sebelumnya. Anda bisa langsung lanjut, atau perbarui bila ada perubahan.
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setEditProfile(true)}>Perbarui Profil</Button>
                <Button className="flex-1" disabled={!namaOk} onClick={() => setStep(2)}>Gunakan data ini →</Button>
              </div>
            </>
          ) : (
            <>
              {prefill.multi_match && (
                <p className="text-xs text-amber-600">Beberapa profil terkait nomor ini — silakan lengkapi data Anda; petugas akan memverifikasi.</p>
              )}
              <VisitorForm value={effGuest} onChange={setGuest} restoreFromStorage={false} />
              <div className="flex gap-2">
                {known && (
                  <Button variant="outline" className="flex-1" onClick={() => { setEditProfile(false); setGuest(null) }}>Batal</Button>
                )}
                <Button className="flex-1" disabled={!namaOk} onClick={() => setStep(2)}>Lanjut →</Button>
              </div>
            </>
          )}
        </section>
      )}

      {/* ── Langkah 2 — Data yang Dibutuhkan ── */}
      {step === 2 && (
        <section className="space-y-4">
          <h2 className="font-semibold">B. Data yang Dibutuhkan</h2>
          <PermintaanDataForm rows={rows} onChange={setRows} />
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setStep(1)}>← Kembali</Button>
            <Button className="flex-1" disabled={!permintaanOk || !namaOk || !yearsOk || submit.isPending} onClick={() => submit.mutate()}>
              {submit.isPending ? 'Mengirim…' : 'Kirim Permintaan'}
            </Button>
          </div>
        </section>
      )}
    </div>
  )
}
