import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { kioskApi } from '@/api/kiosk'
import { PhotoDisclaimer } from '@/components/kiosk/PhotoDisclaimer'
import { FaceCapture } from '@/components/kiosk/FaceCapture'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { useInactivityTimeout } from '@/hooks/useInactivityTimeout'
import { STORAGE_KEY } from '@/components/kiosk/VisitorForm'
import type { GuestFormData } from '@/types/guest'
import { getApiErrorMessage } from '@/lib/apiError'

export default function FaceCapturePage() {
  const navigate = useNavigate()
  const location = useLocation()

  const formData: GuestFormData = location.state?.formData
  const jenis_layanan: string[] = location.state?.jenis_layanan ?? []
  const layanan_lainnya: string = location.state?.layanan_lainnya ?? ''
  const sarana: number[] = location.state?.sarana ?? []
  const sarana_lainnya: string = location.state?.sarana_lainnya ?? ''

  const [consentAccepted, setConsentAccepted] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useInactivityTimeout(() => navigate('/kiosk'), 120000)

  const registerMutation = useMutation({
    mutationFn: (payload: { photo: string; descriptor: Float32Array | null }) =>
      kioskApi.register({
        ...formData,
        foto: payload.photo,
        face_descriptor: payload.descriptor ? Array.from(payload.descriptor) : [],
        jenis_layanan,
        layanan_lainnya,
        sarana,
        sarana_lainnya,
        biometric_consent: true,
        consent_timestamp: new Date().toISOString(),
      }),
    onSuccess: (res) => {
      localStorage.removeItem(STORAGE_KEY)
      const visitId = res.data.data.id_kunjungan
      navigate(`/kiosk/ticket/${visitId}`)
    },
    onError: (err: Error) => {
      // err.message dari axios berbahasa Inggris dan teknis ("Request failed with
      // status code 500") — persis di detik pengunjung butuh arahan. Backend sudah
      // mengirim pesan Indonesia di amplop {success,data,message}; ambil itu.
      // WaCheckInPage sudah melakukannya. AUDIT_2026-08-01 #24e.
      setSubmitError(getApiErrorMessage(err, 'Terjadi kesalahan. Silakan coba lagi.'))
    },
  })

  const handleDecline = () => {
    navigate('/kiosk/form', { state: { formData, jenis_layanan, layanan_lainnya, sarana, sarana_lainnya } })
  }

  const handlePhotoConfirm = (photo: string, descriptor: Float32Array | null) => {
    setSubmitError(null)
    registerMutation.mutate({ photo, descriptor })
  }

  if (!formData) {
    return (
      <div className="text-gray-800 text-center">
        <p className="text-xl mb-4">Data tidak ditemukan</p>
        <button
          onClick={() => navigate('/kiosk')}
          className="px-8 py-4 bg-orange-500 rounded-xl text-white font-bold"
        >
          Mulai Ulang
        </button>
      </div>
    )
  }

  return (
    <>
      {/* Photo consent disclaimer */}
      {!consentAccepted && (
        <PhotoDisclaimer
          onAccept={() => setConsentAccepted(true)}
          onDecline={handleDecline}
        />
      )}

      <div className="flex flex-col items-center text-gray-800 px-4 max-w-2xl w-full mx-auto">
        <h1 className="text-xl font-bold mb-1">Verifikasi Wajah</h1>
        <p className="text-gray-500 mb-3 text-center text-xs">
          Ambil foto wajah Anda untuk menyelesaikan pendaftaran
        </p>

        {registerMutation.isPending ? (
          <div className="flex flex-col items-center gap-4">
            <LoadingSpinner />
            <p className="text-gray-500 text-lg">Mendaftarkan pengunjung...</p>
          </div>
        ) : (
          <>
            {consentAccepted && <FaceCapture onConfirm={handlePhotoConfirm} />}

            {submitError && (
              <div className="mt-4 p-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-center text-sm overflow-hidden">
                {submitError}
              </div>
            )}
          </>
        )}

        <button
          onClick={() => navigate('/kiosk/form', { state: { formData, jenis_layanan, layanan_lainnya, sarana, sarana_lainnya } })}
          className="mt-4 px-6 py-2 text-gray-500 hover:text-gray-800 underline text-base transition-colors"
          disabled={registerMutation.isPending}
        >
          Kembali
        </button>
      </div>
    </>
  )
}
