import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import axios from 'axios'
import { MessageCircle, MapPin } from 'lucide-react'
import { kioskApi } from '@/api/kiosk'
import { PhotoDisclaimer } from '@/components/kiosk/PhotoDisclaimer'
import { FaceCapture } from '@/components/kiosk/FaceCapture'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { useInactivityTimeout } from '@/hooks/useInactivityTimeout'

function errText(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) return (err.response?.data as { message?: string } | undefined)?.message || fallback
  return err instanceof Error ? err.message : fallback
}

/**
 * Kiosk check-in for visitors who registered via the WhatsApp online service.
 * Identity-first flow (no pre-selected service):
 *   (1) Enter phone → waLookup (server resolves service from WA registration)
 *   (2) Scan face → waPromote (sends only face + consent, NO jenis_layanan/sarana)
 *   Result: mode='queue' → ticket page; mode='resepsionis' → front-desk instruction.
 */
export default function WaCheckInPage() {
  const navigate = useNavigate()

  const [phone, setPhone] = useState('')
  const [matched, setMatched] = useState<{
    nama: string
    id_kunjungan: number
    nomor_antrian: string | null
    kiosk_token: string
  } | null>(null)
  const [consentAccepted, setConsentAccepted] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [promoteResult, setPromoteResult] = useState<{
    mode: 'queue' | 'resepsionis'
    id_kunjungan: number
    nomor_antrian: string | null
  } | null>(null)

  useInactivityTimeout(() => navigate('/kiosk'), 120000)

  const lookupMutation = useMutation({
    mutationFn: (p: string) => kioskApi.waLookup(p),
    onSuccess: (res) => { setErrorMsg(null); setMatched(res.data.data) },
    onError: (err) => {
      const status = axios.isAxiosError(err) ? err.response?.status : null
      if (status === 404) {
        setErrorMsg('Nomor tidak terdaftar via WhatsApp. Silakan gunakan jalur "Belum Pernah Daftar" atau hubungi WhatsApp BPS terlebih dahulu.')
      } else if (status === 409) {
        setErrorMsg(errText(err, 'Kunjungan Anda sudah tercatat selesai.'))
      } else {
        setErrorMsg(errText(err, 'Gagal mencari nomor. Silakan coba lagi.'))
      }
    },
  })

  const promoteMutation = useMutation({
    mutationFn: (payload: { photo: string; descriptor: Float32Array | null }) =>
      kioskApi.waPromote(
        {
          id_kunjungan: matched!.id_kunjungan,
          foto: payload.photo,
          face_descriptor: payload.descriptor ? Array.from(payload.descriptor) : [],
          biometric_consent: true,
          consent_timestamp: new Date().toISOString(),
        },
        matched!.kiosk_token,
      ),
    onSuccess: (res) => {
      const { mode, id_kunjungan, nomor_antrian } = res.data.data
      if (mode === 'queue') {
        navigate(`/kiosk/ticket/${id_kunjungan}`)
      } else {
        setPromoteResult({ mode: 'resepsionis', id_kunjungan, nomor_antrian })
      }
    },
    onError: (err) => setErrorMsg(errText(err, 'Gagal menyimpan check-in. Silakan coba lagi.')),
  })

  function submitPhone(e: FormEvent) {
    e.preventDefault()
    const p = phone.trim()
    if (p.replace(/\D/g, '').length < 8) { setErrorMsg('Masukkan nomor HP yang valid.'); return }
    setErrorMsg(null)
    lookupMutation.mutate(p)
  }

  function resetToPhone() {
    setMatched(null)
    setConsentAccepted(false)
    setErrorMsg(null)
    setPromoteResult(null)
  }

  // ── Result: resepsionis ──
  if (promoteResult?.mode === 'resepsionis') {
    return (
      <div className="flex flex-col items-center text-gray-800 px-4 max-w-md w-full mx-auto text-center">
        <div className="w-20 h-20 rounded-full bg-orange-100 flex items-center justify-center mb-4">
          <MapPin className="w-10 h-10 text-orange-500" />
        </div>
        <h1 className="text-2xl font-bold mb-2">Check-in Berhasil!</h1>
        <p className="text-gray-500 mb-4 text-sm">
          Layanan Anda akan ditangani di Resepsionis.
        </p>
        <div className="w-full p-5 rounded-2xl bg-orange-50 border-2 border-orange-200 mb-6">
          <p className="text-lg font-bold text-orange-700">Silakan menuju meja Resepsionis</p>
          <p className="text-gray-500 text-sm mt-1">Petugas kami siap membantu Anda</p>
        </div>
        <button
          onClick={() => navigate('/kiosk')}
          className="w-full px-6 py-3 rounded-xl bg-orange-500 hover:bg-orange-600 text-white font-bold text-lg transition-all active:scale-95 cursor-pointer"
        >
          Selesai
        </button>
      </div>
    )
  }

  // ── Step 2: face capture (after phone matched) ──
  if (matched) {
    return (
      <>
        {!consentAccepted && (
          <PhotoDisclaimer onAccept={() => setConsentAccepted(true)} onDecline={resetToPhone} />
        )}
        <div className="flex flex-col items-center text-gray-800 px-4 max-w-2xl w-full mx-auto">
          <h1 className="text-xl font-bold mb-1">Halo, {matched.nama}</h1>
          <p className="text-gray-500 mb-3 text-center text-xs">
            Pindai wajah Anda untuk menyelesaikan check-in
          </p>

          {promoteMutation.isPending ? (
            <div className="flex flex-col items-center gap-4">
              <LoadingSpinner />
              <p className="text-gray-500 text-lg">Memproses check-in...</p>
            </div>
          ) : (
            <>
              {consentAccepted && <FaceCapture onConfirm={(photo, descriptor) => { setErrorMsg(null); promoteMutation.mutate({ photo, descriptor }) }} />}
              {errorMsg && (
                <div className="mt-4 p-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-center text-sm overflow-hidden">
                  {errorMsg}
                </div>
              )}
            </>
          )}

          <button
            onClick={resetToPhone}
            className="mt-4 px-6 py-2 text-gray-500 hover:text-gray-800 underline text-base transition-colors"
            disabled={promoteMutation.isPending}
          >
            Ganti Nomor
          </button>
        </div>
      </>
    )
  }

  // ── Step 1: phone input ──
  return (
    <div className="flex flex-col items-center text-gray-800 px-4 max-w-md w-full mx-auto">
      <div className="w-16 h-16 rounded-full bg-orange-100 flex items-center justify-center mb-3">
        <MessageCircle className="w-8 h-8 text-orange-500" />
      </div>
      <h1 className="text-xl font-bold mb-1">Check-in Layanan Online</h1>
      <p className="text-gray-500 mb-5 text-center text-sm">
        Masukkan nomor HP yang Anda gunakan saat mendaftar lewat WhatsApp
      </p>

      <form onSubmit={submitPhone} className="w-full flex flex-col gap-3">
        <input
          type="tel"
          inputMode="numeric"
          autoFocus
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Contoh: 0812xxxxxxx"
          className="w-full px-4 py-3 rounded-xl border-2 border-gray-300 text-lg text-center focus:border-orange-400 outline-none transition-colors"
        />
        {errorMsg && (
          <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-center text-sm overflow-hidden">
            {errorMsg}
          </div>
        )}
        <button
          type="submit"
          disabled={lookupMutation.isPending}
          className="w-full px-6 py-3 rounded-xl bg-orange-500 hover:bg-orange-600 text-white font-bold text-lg transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
        >
          {lookupMutation.isPending ? 'Mencari...' : 'Lanjut'}
        </button>
      </form>

      <button
        onClick={() => navigate('/kiosk')}
        className="mt-4 px-6 py-2 text-gray-500 hover:text-gray-800 underline text-base transition-colors cursor-pointer"
      >
        Kembali
      </button>
    </div>
  )
}
