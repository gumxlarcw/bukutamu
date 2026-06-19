import { useState, type FormEvent } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import axios from 'axios'
import { MessageCircle } from 'lucide-react'
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
 * They never captured a face, so here they only: (1) enter their phone → look up
 * their existing WA visit, (2) scan their face → that enrolls the biometric AND
 * promotes the WA visit onto the physical queue (service = the kiosk-picked one
 * carried in router state from ServiceSelectPage).
 */
export default function WaCheckInPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const jenis_layanan: string[] = location.state?.jenis_layanan ?? []
  const layanan_lainnya: string = location.state?.layanan_lainnya ?? ''
  const sarana: number[] = location.state?.sarana ?? []
  const sarana_lainnya: string = location.state?.sarana_lainnya ?? ''

  const [phone, setPhone] = useState('')
  const [matched, setMatched] = useState<{ nama: string; id_kunjungan: number; kiosk_token: string } | null>(null)
  const [consentAccepted, setConsentAccepted] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useInactivityTimeout(() => navigate('/kiosk'), 120000)

  const lookupMutation = useMutation({
    mutationFn: (p: string) => kioskApi.waLookup(p),
    onSuccess: (res) => { setErrorMsg(null); setMatched(res.data.data) },
    onError: (err) => setErrorMsg(errText(err, 'Gagal mencari nomor. Silakan coba lagi.')),
  })

  const promoteMutation = useMutation({
    mutationFn: (payload: { photo: string; descriptor: Float32Array | null }) =>
      kioskApi.waPromote(
        {
          id_kunjungan: matched!.id_kunjungan,
          foto: payload.photo,
          face_descriptor: payload.descriptor ? Array.from(payload.descriptor) : [],
          jenis_layanan,
          layanan_lainnya,
          sarana,
          sarana_lainnya,
          biometric_consent: true,
          consent_timestamp: new Date().toISOString(),
        },
        matched!.kiosk_token,
      ),
    onSuccess: (res) => navigate(`/kiosk/ticket/${res.data.data.id_kunjungan}`),
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
  }

  // ── Step 2: face capture (after phone is matched) ──
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
          className="w-full px-6 py-3 rounded-xl bg-orange-500 hover:bg-orange-600 text-white font-bold text-lg transition-all active:scale-95 disabled:opacity-50"
        >
          {lookupMutation.isPending ? 'Mencari...' : 'Lanjut'}
        </button>
      </form>

      <button
        onClick={() => navigate('/kiosk/status', { state: location.state })}
        className="mt-4 px-6 py-2 text-gray-500 hover:text-gray-800 underline text-base transition-colors"
      >
        Kembali
      </button>
    </div>
  )
}
