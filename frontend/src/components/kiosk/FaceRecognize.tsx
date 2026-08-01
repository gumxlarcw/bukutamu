import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { kioskApi } from '@/api/kiosk'
import { isKioskNotActivated } from '@/lib/kioskDevice'
import { useCamera } from '@/hooks/useCamera'
import { matchFace, type KnownFace } from '@/lib/face-detection'
import { Loader2, UserCheck, User, RefreshCw, Search } from 'lucide-react'

interface MatchResult {
  id: number
  nama: string
}

interface FaceRecognizeProps {
  onMatch: (match: MatchResult) => void
  onNoMatch: () => void
  onManualSelect: () => void
}

export function FaceRecognize({ onMatch, onNoMatch, onManualSelect }: FaceRecognizeProps) {
  const {
    videoRef,
    isModelLoading,
    isCameraActive,
    faceDetected,
    error,
    stableDescriptor,
    sampleCount,
    sampleTarget,
    isWarmingUp,
    startCamera,
    stopCamera,
  } = useCamera()

  const [matched, setMatched] = useState<MatchResult | null>(null)
  const { data: faceData, isLoading: isFaceDataLoading, error: faceDataError } = useQuery({
    queryKey: ['face-data'],
    queryFn: () => kioskApi.getFaceData().then(r => r.data.data),
    // Mesin yang belum diaktifkan akan SELALU 401 — mengulang hanya menunda
    // pesan yang benar dan membebani endpoint.
    retry: (count, err) => !isKioskNotActivated(err) && count < 2,
  })
  // Dibedakan dari galat jaringan biasa: 401/403 di sini berarti mesin ini belum
  // terdaftar sebagai kiosk, dan yang dibutuhkan adalah tindakan ADMIN, bukan
  // "coba lagi". Lihat lib/kioskDevice.ts + AUDIT_2026-08-01 #1.
  const notActivated = isKioskNotActivated(faceDataError)

  useEffect(() => {
    startCamera()
    return () => stopCamera()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Match hanya pakai stableDescriptor (averaged). Single-frame match dihindari
  // karena descriptor mentah pertama sering noisy → mismatch atau false-positive.
  useEffect(() => {
    if (!faceData || !stableDescriptor || matched) return

    const knownFaces: KnownFace[] = faceData
      .filter(f => f.face_descriptor && f.face_descriptor.length > 0)
      .map(f => ({
        id: f.id_user,
        nama: f.nama,
        descriptor: new Float32Array(f.face_descriptor),
      }))

    if (knownFaces.length === 0) return

    const result = matchFace(stableDescriptor, knownFaces)
    if (result) {
      setMatched({ id: result.id, nama: result.nama })
      stopCamera()
    } else {
      // Stable descriptor sudah jadi tapi tidak ada match yang confident.
      // Biarkan user lihat status "tidak dikenali" sambil kamera tetap idle (sample
      // sudah penuh, tidak akan collect lagi). User bisa "Scan Ulang" untuk reset.
    }
  }, [stableDescriptor, faceData, matched, stopCamera])

  const handleConfirm = () => {
    if (matched) onMatch(matched)
  }

  const handleRescan = () => {
    setMatched(null)
    startCamera()  // Reset buffer + framesSeen di dalam startCamera
  }

  const isLoading = isModelLoading || isFaceDataLoading
  const samplingActive = !isWarmingUp && faceDetected && !stableDescriptor && !matched
  const samplingDone = !!stableDescriptor && !matched
  const noMatchFound = samplingDone  // stable ready tapi matched=null → tidak ada match

  if (notActivated) {
    return (
      <div className="flex flex-col items-center gap-5 text-center px-6">
        <div className="w-20 h-20 rounded-full bg-amber-100 flex items-center justify-center">
          <span className="text-4xl">🔒</span>
        </div>
        <div>
          <h2 className="text-xl font-bold text-gray-800">Kiosk belum diaktifkan</h2>
          <p className="text-gray-500 text-sm mt-2 max-w-md">
            Komputer ini belum terdaftar sebagai perangkat kiosk, sehingga pengenalan wajah
            tidak dapat dijalankan. Mohon hubungi petugas admin untuk mengaktifkannya melalui
            menu <strong>Aktivasi Perangkat Kiosk</strong>.
          </p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-6 text-center">
        <div className="w-20 h-20 rounded-full bg-red-100 flex items-center justify-center">
          <User className="w-10 h-10 text-red-500" />
        </div>
        <p className="text-red-600 text-lg">{error}</p>
        <button
          onClick={() => startCamera()}
          className="px-6 py-3 rounded-xl bg-orange-500 hover:bg-orange-400 text-white font-bold text-lg"
        >
          Coba Lagi
        </button>
      </div>
    )
  }

  // ── Status messaging: fase-fase berbeda supaya user tahu progress ──
  let statusText = ''
  let statusColor = 'text-gray-400'
  if (!matched && isCameraActive && !isLoading) {
    if (isWarmingUp) {
      statusText = '📸 Mempersiapkan kamera...'
      statusColor = 'text-blue-500'
    } else if (!faceDetected) {
      statusText = 'Posisikan wajah Anda dalam lingkaran'
      statusColor = 'text-gray-500'
    } else if (samplingActive) {
      statusText = `🔍 Mengenali wajah... ${sampleCount}/${sampleTarget}`
      statusColor = 'text-orange-600'
    } else if (noMatchFound) {
      statusText = '😕 Wajah tidak dikenali — coba scan ulang atau cari manual'
      statusColor = 'text-amber-600'
    }
  }

  return (
    <div className="flex flex-col items-center gap-4">
      {/* Video area */}
      <div className="relative w-56 h-56 rounded-full overflow-hidden border-4 border-orange-400 shadow-2xl bg-gray-100">
        {/* Face guide oval */}
        {!matched && (
          <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
            <div
              className={`w-40 h-44 rounded-full border-4 transition-colors duration-300 ${
                samplingActive
                  ? 'border-orange-400 shadow-[0_0_20px_rgba(251,146,60,0.5)] animate-pulse'
                  : faceDetected
                  ? 'border-orange-400'
                  : 'border-gray-400/40'
              }`}
            />
          </div>
        )}

        {/* Loading overlay (model + face data fetch) */}
        {isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/80 z-20">
            <Loader2 className="w-12 h-12 text-orange-500 animate-spin mb-3" />
            <p className="text-gray-600 text-sm">
              {isModelLoading ? 'Memuat model...' : 'Memuat data wajah...'}
            </p>
          </div>
        )}

        {/* Match overlay */}
        {matched && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-orange-500/80 z-20">
            <UserCheck className="w-16 h-16 text-white mb-3" />
            <p className="text-white font-bold text-sm text-center px-3 break-words leading-snug">{matched.nama}</p>
          </div>
        )}

        <video
          ref={videoRef}
          className={`w-full h-full object-cover ${matched ? 'opacity-30' : ''}`}
          muted
          playsInline
        />
      </div>

      {/* Status text */}
      {!matched && isCameraActive && !isLoading && (
        <p className={`text-base font-semibold transition-colors duration-200 ${statusColor}`}>
          {statusText}
        </p>
      )}

      {/* Progress bar untuk sampling phase — biar user tahu scan sedang jalan, bukan stuck */}
      {samplingActive && (
        <div className="w-48 h-2 bg-gray-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-orange-500 transition-all duration-300 ease-out"
            style={{ width: `${(sampleCount / sampleTarget) * 100}%` }}
          />
        </div>
      )}

      {/* Match result */}
      {matched && (
        <div className="text-center">
          <p className="text-orange-600 text-sm font-bold mb-0.5">Wajah Dikenali!</p>
          <p className="text-gray-800 text-lg font-bold break-words leading-snug">{matched.nama}</p>
          <p className="text-gray-500 text-sm">Apakah ini Anda?</p>
        </div>
      )}

      {/* Buttons — matched state */}
      {matched && (
        <div className="flex flex-col items-center gap-3 w-full max-w-sm">
          <button
            onClick={handleConfirm}
            className="w-full px-6 py-3 rounded-xl bg-orange-500 hover:bg-orange-400 text-white text-base font-bold shadow-lg transition-all active:scale-95 cursor-pointer"
          >
            Ya, Itu Saya
          </button>
          <div className="flex gap-3 w-full">
            <button
              onClick={handleRescan}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border-2 border-gray-300 text-gray-700 text-sm font-semibold hover:bg-white/60 transition-all active:scale-95 cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" />
              Scan Ulang
            </button>
            <button
              onClick={onManualSelect}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border-2 border-gray-300 text-gray-700 text-sm font-semibold hover:bg-white/60 transition-all active:scale-95 cursor-pointer"
            >
              <Search className="w-4 h-4" />
              Cari Manual
            </button>
          </div>
        </div>
      )}

      {/* Buttons — scanning state (warmup/sampling/no-match) */}
      {!matched && !isLoading && (
        <div className="flex gap-3">
          {noMatchFound && (
            <button
              onClick={handleRescan}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-orange-500 hover:bg-orange-400 text-white text-sm font-bold shadow-md transition-all active:scale-95 cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" />
              Scan Ulang
            </button>
          )}
          <button
            onClick={onManualSelect}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl border-2 border-gray-300 text-gray-700 text-sm font-semibold hover:bg-white/60 transition-all active:scale-95 cursor-pointer"
          >
            <Search className="w-4 h-4" />
            Cari Manual
          </button>
          <button
            onClick={onNoMatch}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl border-2 border-gray-300 text-gray-700 text-sm font-semibold hover:bg-white/60 transition-all active:scale-95 cursor-pointer"
          >
            Daftar Baru
          </button>
        </div>
      )}
    </div>
  )
}
