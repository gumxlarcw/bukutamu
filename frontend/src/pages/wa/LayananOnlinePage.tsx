import { useState, useMemo, useEffect, useRef } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CheckCircle2, User, LayoutGrid, Clock } from 'lucide-react'
import { waApi } from '@/api/wa'
import { VisitorForm } from '@/components/kiosk/VisitorForm'
import { ServiceSaranaSelector } from '@/components/kiosk/ServiceSaranaSelector'
import type { ServiceSaranaSelectorValue } from '@/components/kiosk/ServiceSaranaSelector'
import { PermintaanDataForm, emptyPermintaanRow, permintaanRowsValid } from '@/components/wa/PermintaanDataForm'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import type { GuestFormData } from '@/types/guest'
import type { WaPermintaanRow } from '@/types/wa'
import { JAM_LAYANAN } from '@/types/wa'

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

/** Layar sukses bergaya tiket kiosk — nomor besar + detail Nama / Layanan / Tanggal. */
function SuccessTicket({ ticket, offline = false, nomorAntrian, nama, layanan }: { ticket: string; offline?: boolean; nomorAntrian?: string | null; nama?: string | null; layanan?: string | null }) {
  const hasNomor = !!(offline && nomorAntrian)
  const displayCode = hasNomor ? (nomorAntrian as string) : ticket
  const displayLabel = hasNomor ? 'Nomor Antrian' : offline ? 'Kode Pendaftaran' : 'Nomor Tiket'
  const tanggal = new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

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
        <span className="absolute -left-3 top-[44%] w-6 h-6 rounded-full" style={{ background: '#ffe7cc' }} />
        <span className="absolute -right-3 top-[44%] w-6 h-6 rounded-full" style={{ background: '#ffe7cc' }} />

        <div className="w-14 h-14 mx-auto rounded-full bg-emerald-100 grid place-items-center mb-3">
          <CheckCircle2 className="w-8 h-8 text-emerald-600" />
        </div>
        <p className="text-orange-600 font-semibold text-xs uppercase tracking-[0.2em]">{offline ? 'Pendaftaran Diterima' : 'Permintaan Diterima'}</p>
        <h2 className="text-base font-bold text-gray-900 mb-4">BPS Provinsi Maluku Utara</h2>

        <div className="wa-tk-glow bg-orange-50 border-2 border-orange-200 rounded-xl py-4 px-3 mb-4">
          <p className="text-orange-600 text-[11px] font-semibold mb-1 uppercase tracking-wide">{displayLabel}</p>
          <p className={`${hasNomor ? 'text-5xl' : 'text-3xl'} font-black text-orange-600 leading-none tracking-tight font-mono`}><CountUp text={displayCode} /></p>
        </div>

        {/* Detail tiket — meniru QueueTicket kiosk (Nama / Layanan / Tanggal) */}
        <div className="flex gap-2 text-left mb-4">
          <div className="flex items-start gap-1.5 flex-1 min-w-0">
            <User className="w-3.5 h-3.5 text-orange-500 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-[10px] text-gray-500 font-medium uppercase">Nama</p>
              <p className="font-semibold text-gray-800 text-xs break-words leading-snug">{nama || '—'}</p>
            </div>
          </div>
          <div className="flex items-start gap-1.5 flex-1 min-w-0">
            <LayoutGrid className="w-3.5 h-3.5 text-orange-500 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-[10px] text-gray-500 font-medium uppercase">Layanan</p>
              <p className="font-semibold text-gray-800 text-xs break-words leading-snug">{layanan || '—'}</p>
            </div>
          </div>
          <div className="flex items-start gap-1.5 flex-1 min-w-0">
            <Clock className="w-3.5 h-3.5 text-orange-500 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-[10px] text-gray-500 font-medium uppercase">Tanggal</p>
              <p className="font-semibold text-gray-800 text-[10px] break-words leading-snug">{tanggal}</p>
            </div>
          </div>
        </div>

        {hasNomor ? (
          <p className="text-sm text-gray-700 leading-relaxed">
            Nomor antrian Anda <b>berlaku hari ini</b>. Datang ke kantor BPS Maluku Utara, bagian <b>Resepsionis</b>, untuk mencetak tiket.
          </p>
        ) : offline ? (
          <p className="text-sm text-gray-600 leading-relaxed">
            Pendaftaran diterima. Datang ke kantor pada jam layanan dan langsung menuju meja <b>Resepsionis</b>.
          </p>
        ) : (
          <p className="text-sm text-gray-600 leading-relaxed">
            Terima kasih, permintaan data Anda telah kami terima dan masuk antrian layanan online.
          </p>
        )}
        <p className="text-xs text-gray-500 mt-2 leading-relaxed">
          {offline ? 'Jam layanan' : 'Akan diproses pada jam operasional layanan'}<br />{JAM_LAYANAN}.
        </p>
        <div className="mt-4 text-[11px] text-gray-400 border-t border-dashed border-gray-300 pt-3">
          Simpan / screenshot tiket ini sebagai bukti pendaftaran Anda.
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

const emptySvcValue: ServiceSaranaSelectorValue = {
  jenis_layanan: [], layanan_lainnya: '', sarana: [], sarana_lainnya: '',
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
  // Kategori #2 "Daftar Antrian Offline" → form Data Diri + Pilih Layanan (tanpa langkah Permintaan Data).
  const isOffline = prefill?.category === 'offline'

  const [guest, setGuest] = useState<GuestFormData | null>(null)
  const [rows, setRows] = useState<WaPermintaanRow[]>([emptyPermintaanRow()])
  // Stable setter reference — required by ServiceSaranaSelector's pruning effect (onChange not in its deps).
  const [svcValue, setSvcValue] = useState<ServiceSaranaSelectorValue>(emptySvcValue)
  const [ticket, setTicket] = useState<string | null>(null)
  const [nomorAntrian, setNomorAntrian] = useState<string | null>(null)
  const [step, setStep] = useState<1 | 2>(1)         // 1 = Data Diri, 2 = Pilih Layanan (offline) | Data yang Dibutuhkan (data/lainnya)
  const [editProfile, setEditProfile] = useState(false) // true → user memilih "Perbarui Profil"
  const effGuest = guest ?? initialGuest

  const submit = useMutation({
    mutationFn: () => {
      const payload = isOffline
        ? {
            ...effGuest,
            permintaan: [],
            update_profile: editProfile,
            jenis_layanan: svcValue.jenis_layanan,
            layanan_lainnya: svcValue.layanan_lainnya,
            sarana: svcValue.sarana,
            sarana_lainnya: svcValue.sarana_lainnya,
          }
        : { ...effGuest, permintaan: rows, update_profile: editProfile }
      return waApi.submitSession(Number(sessionId), token, payload).then(r => r.data.data)
    },
    onSuccess: (d) => {
      setTicket(d?.ticket ?? null)
      setNomorAntrian(d?.nomor_antrian ?? null)
    },
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
    // Service label: from the form just submitted (svcValue) or, on reopen, from the
    // visit the backend returns; non-offline shows its category label.
    const successLayanan = isOffline
      ? (svcValue.jenis_layanan.length ? svcValue.jenis_layanan.join(', ') : (prefill.jenis_layanan?.join(', ') || '—'))
      : (prefill.category === 'lainnya' ? 'Lainnya' : 'Permintaan Data / Konsultasi')
    const successNama = (effGuest?.nama || prefill.guest?.nama || '—')
    return <SuccessTicket
      ticket={ticket ?? (prefill.id_kunjungan ? `WA-${prefill.id_kunjungan}` : `WA-${prefill.session_id}`)}
      offline={isOffline}
      nomorAntrian={nomorAntrian ?? prefill.nomor_antrian ?? null}
      nama={successNama}
      layanan={successLayanan} />
  }

  const namaOk = effGuest.nama.trim() !== ''
  const permintaanOk = rows.some(r => r.rincian_data.trim() !== '')
  const yearsOk = permintaanRowsValid(rows)   // tahun_akhir ≥ tahun_awal & format wajar
  const serviceOk = svcValue.jenis_layanan.length > 0

  return (
    <div className="max-w-md mx-auto p-4 space-y-6">
      <header className="text-center space-y-2">
        <h1 className="text-lg font-bold">Layanan Data BPS Maluku Utara</h1>
        <p className="text-sm text-muted-foreground">
          {`Langkah ${step} dari 2 — ${step === 1 ? 'Data Diri' : isOffline ? 'Pilih Layanan' : 'Data yang Dibutuhkan'}`}
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
                <Button className="flex-1" disabled={!namaOk} onClick={() => setStep(2)}>
                  {isOffline ? 'Lanjut →' : 'Gunakan data ini →'}
                </Button>
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
                <Button className="flex-1" disabled={!namaOk} onClick={() => setStep(2)}>
                  Lanjut →
                </Button>
              </div>
            </>
          )}
        </section>
      )}

      {/* ── Langkah 2 — Pilih Layanan (offline) ── */}
      {step === 2 && isOffline && (
        <section className="space-y-4">
          <h2 className="font-semibold">B. Pilih Layanan</h2>
          <ServiceSaranaSelector value={svcValue} onChange={setSvcValue} />
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setStep(1)}>← Kembali</Button>
            <Button className="flex-1" disabled={!serviceOk || submit.isPending} onClick={() => submit.mutate()}>
              {submit.isPending ? 'Mendaftar…' : 'Daftar'}
            </Button>
          </div>
        </section>
      )}

      {/* ── Langkah 2 — Data yang Dibutuhkan (data / lainnya) ── */}
      {step === 2 && !isOffline && (
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
