import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { kioskApi } from '@/api/kiosk'
import { FaceRecognize } from '@/components/kiosk/FaceRecognize'
import { GuestPickerModal } from '@/components/kiosk/GuestPickerModal'
import { ProfileGapsModal } from '@/components/kiosk/ProfileGapsModal'
import { useInactivityTimeout } from '@/hooks/useInactivityTimeout'
import { getApiErrorMessage } from '@/lib/apiError'

interface MatchedGuest {
  id: number
  nama: string
}

export default function FaceRecognizePage() {
  const navigate = useNavigate()
  const location = useLocation()
  const visitState = location.state ?? {}
  const jenis_layanan: string[] = visitState.jenis_layanan ?? []
  const layanan_lainnya: string = visitState.layanan_lainnya ?? ''
  const sarana: number[] = visitState.sarana ?? []
  const sarana_lainnya: string = visitState.sarana_lainnya ?? ''
  const [matchedGuest, setMatchedGuest] = useState<MatchedGuest | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  // Profile gaps state
  const [profileGaps, setProfileGaps] = useState<string[] | null>(null)
  const [profileToken, setProfileToken] = useState<string | null>(null)
  const [gapsModalOpen, setGapsModalOpen] = useState(false)
  const [gapsChecked, setGapsChecked] = useState(false)

  useInactivityTimeout(() => navigate('/kiosk'), 120000)

  // Check profile gaps when guest is confirmed. Backend now returns a
  // 5-min kiosk_token along with the gaps; we cache it and pass it to
  // updateProfile so the backend trusts the follow-up mutation.
  useEffect(() => {
    if (!matchedGuest || gapsChecked) return
    kioskApi.getProfileGaps(matchedGuest.id)
      .then(res => {
        const gaps = res.data.data.gaps
        setProfileGaps(gaps)
        setProfileToken(res.data.data.kiosk_token)
        if (gaps.length > 0) setGapsModalOpen(true)
        setGapsChecked(true)
      })
      .catch(() => setGapsChecked(true))
  }, [matchedGuest, gapsChecked])

  const updateProfileMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => {
      if (!profileToken) throw new Error('Token profil hilang — silakan ulangi pengenalan wajah.')
      return kioskApi.updateProfile(matchedGuest!.id, data, profileToken)
    },
    onSuccess: () => {
      setGapsModalOpen(false)
      setProfileGaps([])
    },
  })

  const visitMutation = useMutation({
    mutationFn: (data: { id_user: number; jenis_layanan: string[]; layanan_lainnya: string; sarana: number[]; sarana_lainnya: string }) =>
      kioskApi.visit(data),
    onSuccess: (res) => {
      navigate(`/kiosk/ticket/${res.data.data.id_kunjungan}`)
    },
    onError: (err: Error) => {
      // err.message dari axios berbahasa Inggris dan teknis ("Request failed with
      // status code 500") — persis di detik pengunjung butuh arahan. Backend sudah
      // mengirim pesan Indonesia di amplop {success,data,message}; ambil itu.
      // WaCheckInPage sudah melakukannya. AUDIT_2026-08-01 #24e.
      setSubmitError(getApiErrorMessage(err, 'Terjadi kesalahan. Silakan coba lagi.'))
    },
  })

  const handleMatch = (guest: MatchedGuest) => {
    setMatchedGuest(guest)
    setGapsChecked(false)
    setProfileGaps(null)
    setProfileToken(null)
  }

  const handleNoMatch = () => navigate('/kiosk/form', { state: visitState })
  const handleManualSelect = () => setPickerOpen(true)

  const handlePickerSelect = (guest: { id: number; nama: string }) => {
    setPickerOpen(false)
    setMatchedGuest(guest)
    setGapsChecked(false)
    setProfileGaps(null)
    setProfileToken(null)
  }

  const handleConfirmVisit = () => {
    if (!matchedGuest) return
    setSubmitError(null)
    visitMutation.mutate({
      id_user: matchedGuest.id,
      jenis_layanan,
      layanan_lainnya,
      sarana,
      sarana_lainnya,
    })
  }

  return (
    <div className="flex flex-col items-center text-gray-800 px-4 max-w-2xl w-full mx-auto">
      <h1 className="kiosk-enter text-xl font-bold mb-1 text-center">Pengenalan Wajah</h1>
      <p className="kiosk-enter text-gray-500 mb-3 text-center text-xs" style={{ animationDelay: '100ms' }}>
        {matchedGuest
          ? `Selamat datang kembali, ${matchedGuest.nama}!`
          : 'Arahkan wajah Anda ke kamera'}
      </p>

      {/* Face recognition view */}
      {!matchedGuest && (
        <FaceRecognize
          onMatch={handleMatch}
          onNoMatch={handleNoMatch}
          onManualSelect={handleManualSelect}
        />
      )}

      {/* Confirmation after match */}
      {matchedGuest && (
        <div className="w-full">
          <div className="mb-3 p-3 rounded-xl bg-white/80 backdrop-blur-sm border border-gray-200 shadow-lg text-center">
            <p className="text-xs mb-0.5 text-gray-600">Layanan yang dipilih:</p>
            <p className="text-base font-bold text-orange-600 break-words leading-snug">{jenis_layanan.join(', ')}</p>
          </div>

          {/* Gaps badge */}
          {profileGaps && profileGaps.length > 0 && !gapsModalOpen && (
            <button
              onClick={() => setGapsModalOpen(true)}
              className="w-full mb-3 p-2.5 rounded-xl bg-amber-50 border border-amber-300 text-amber-700 text-xs font-medium text-center cursor-pointer hover:bg-amber-100 transition-colors"
            >
              Ada {profileGaps.length} data yang belum lengkap — ketuk untuk melengkapi
            </button>
          )}

          {submitError && (
            <div className="mb-4 p-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-center text-sm overflow-hidden">
              {submitError}
            </div>
          )}

          <div className="flex gap-4 w-full max-w-md mx-auto">
            <button
              onClick={() => setMatchedGuest(null)}
              className="flex-1 px-4 py-3 rounded-xl border-2 border-gray-300 text-gray-700 text-base font-semibold hover:bg-white/60 transition-all active:scale-95 cursor-pointer"
              disabled={visitMutation.isPending}
            >
              Kembali
            </button>
            <button
              onClick={handleConfirmVisit}
              disabled={visitMutation.isPending}
              className={`flex-1 px-4 py-3 rounded-xl text-base font-bold transition-all active:scale-95
                ${!visitMutation.isPending
                  ? 'bg-orange-500 hover:bg-orange-400 text-white shadow-xl cursor-pointer'
                  : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                }`}
            >
              {visitMutation.isPending ? 'Memproses...' : 'Konfirmasi'}
            </button>
          </div>
        </div>
      )}

      {/* Back button */}
      <div className="kiosk-enter mt-4 w-full max-w-md mx-auto" style={{ animationDelay: '300ms' }}>
        <button
          onClick={() => navigate('/kiosk/status', { state: visitState })}
          className="w-full px-4 py-3 rounded-xl border-2 border-gray-300 text-gray-700 text-sm font-semibold hover:bg-white/60 transition-all active:scale-95 cursor-pointer"
        >
          Kembali
        </button>
      </div>

      {/* Guest picker modal */}
      <GuestPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={handlePickerSelect}
      />

      {/* Profile gaps modal */}
      {gapsModalOpen && profileGaps && profileGaps.length > 0 && (
        <ProfileGapsModal
          gaps={profileGaps}
          onSubmit={data => updateProfileMutation.mutate(data)}
          onSkip={() => setGapsModalOpen(false)}
          isSubmitting={updateProfileMutation.isPending}
        />
      )}
    </div>
  )
}
