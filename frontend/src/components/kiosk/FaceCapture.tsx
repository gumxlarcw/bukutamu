import { useState, useEffect } from 'react'
import { useCamera } from '@/hooks/useCamera'
import { Camera, RotateCcw, Check, Loader2 } from 'lucide-react'

// Minimum sample sebelum tombol "Ambil Foto" enabled. Lebih kecil dari SAMPLE_TARGET
// supaya capture lebih cepat (user sudah bisa snap saat ~60% sampling done).
// Kalau di-tunggu sampai SAMPLE_TARGET, foto bisa keburu telat (user pindah pose).
const MIN_SAMPLES_TO_CAPTURE = 3

interface FaceCaptureProps {
  onConfirm: (photo: string, descriptor: Float32Array | null) => void
  /** Verifikasi (tamu sudah punya template): pindai saja — auto-kirim deskriptor, tanpa ambil/simpan foto. */
  scanOnly?: boolean
}

export function FaceCapture({ onConfirm, scanOnly = false }: FaceCaptureProps) {
  const {
    videoRef,
    isModelLoading,
    isCameraActive,
    faceDetected,
    error,
    sampleCount,
    sampleTarget,
    isWarmingUp,
    stableDescriptor,
    startCamera,
    stopCamera,
    capturePhoto,
  } = useCamera()

  const [captured, setCaptured] = useState<{ photo: string; descriptor: Float32Array | null } | null>(null)
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    startCamera()
    return () => stopCamera()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleCapture = () => {
    const result = capturePhoto()
    if (result) {
      setCaptured(result)
      stopCamera()
    }
  }

  const handleRetake = () => {
    setCaptured(null)
    setSubmitted(false)
    startCamera()
  }

  const handleConfirm = () => {
    if (captured && !submitted) {
      setSubmitted(true)
      onConfirm(captured.photo, captured.descriptor)
    }
  }

  // Mode verifikasi (scanOnly): begitu deskriptor stabil (sampling cukup), langsung kirim tanpa
  // ambil/simpan foto. Foto kosong → backend wa_promote verifikasi 1:1 & TIDAK menimpa template/consent.
  useEffect(() => {
    if (scanOnly && !submitted && stableDescriptor) {
      setSubmitted(true)
      stopCamera()
      onConfirm('', stableDescriptor)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanOnly, submitted, stableDescriptor])

  // Tombol enabled hanya kalau: face terdeteksi + sample cukup + camera aktif.
  // Tanpa gate sample, foto bisa di-snap saat descriptor mentah masih noisy → recognize
  // di kunjungan berikutnya untuk user ini akan ngaco.
  const canCapture =
    !captured && isCameraActive && faceDetected && sampleCount >= MIN_SAMPLES_TO_CAPTURE
  const samplingActive = !isWarmingUp && faceDetected && !stableDescriptor

  if (error) {
    return (
      <div className="flex flex-col items-center gap-6 text-center">
        <div className="w-20 h-20 rounded-full bg-red-100 flex items-center justify-center">
          <Camera className="w-10 h-10 text-red-500" />
        </div>
        <p className="text-red-600 text-lg">{error}</p>
        <button
          onClick={() => startCamera()}
          className="px-8 py-4 rounded-xl bg-orange-500 hover:bg-orange-400 text-white font-bold text-lg"
        >
          Coba Lagi
        </button>
      </div>
    )
  }

  // ── Status fase: warmup → sampling → ready ──
  let statusText = ''
  let statusColor = 'text-gray-400'
  if (!captured && isCameraActive) {
    if (isWarmingUp) {
      statusText = '📸 Mempersiapkan kamera...'
      statusColor = 'text-blue-500'
    } else if (!faceDetected) {
      statusText = 'Posisikan wajah Anda dalam lingkaran'
      statusColor = 'text-gray-500'
    } else if (samplingActive && sampleCount < MIN_SAMPLES_TO_CAPTURE) {
      statusText = `🔍 Menyempurnakan deteksi... ${sampleCount}/${sampleTarget}`
      statusColor = 'text-orange-600'
    } else {
      statusText = scanOnly ? '✓ Wajah terdeteksi — memverifikasi…' : '✓ Wajah terdeteksi — siap ambil foto'
      statusColor = 'text-green-600'
    }
  } else if (captured) {
    statusText = 'Foto berhasil diambil'
    statusColor = 'text-orange-600'
  }

  return (
    <div className="flex flex-col items-center gap-4">
      {/* Video / Preview area */}
      <div className="relative w-56 h-56 rounded-full overflow-hidden border-4 border-orange-400 shadow-2xl bg-gray-100">
        {/* Oval face guide overlay */}
        {!captured && (
          <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
            <div
              className={`w-40 h-44 rounded-full border-4 transition-colors duration-300 ${
                canCapture
                  ? 'border-green-500 shadow-[0_0_20px_rgba(34,197,94,0.4)]'
                  : samplingActive
                  ? 'border-orange-400 animate-pulse'
                  : faceDetected
                  ? 'border-orange-400'
                  : 'border-gray-400/40'
              }`}
            />
          </div>
        )}

        {/* Loading overlay */}
        {isModelLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/80 z-20">
            <Loader2 className="w-12 h-12 text-orange-500 animate-spin mb-3" />
            <p className="text-gray-600 text-sm">Memuat model...</p>
          </div>
        )}

        {/* Video element */}
        {!captured && (
          <video
            ref={videoRef}
            className="w-full h-full object-cover"
            muted
            playsInline
          />
        )}

        {/* Preview image */}
        {captured && (
          <img
            src={captured.photo}
            alt="Captured"
            className="w-full h-full object-cover"
          />
        )}
      </div>

      {/* Status text */}
      <p className={`text-base font-semibold transition-colors duration-200 ${statusColor}`}>
        {statusText}
      </p>

      {/* Progress bar untuk sampling phase */}
      {samplingActive && sampleCount < sampleTarget && (
        <div className="w-48 h-2 bg-gray-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-orange-500 transition-all duration-300 ease-out"
            style={{ width: `${(sampleCount / sampleTarget) * 100}%` }}
          />
        </div>
      )}

      {/* Action buttons (hidden in scanOnly: verification auto-submits the descriptor) */}
      {!scanOnly && (!captured ? (
        <button
          onClick={handleCapture}
          disabled={!canCapture}
          className={`flex items-center gap-2 px-6 py-3 rounded-xl text-base font-bold shadow-xl transition-all
            ${canCapture
              ? 'bg-orange-500 hover:bg-orange-400 text-white active:scale-95'
              : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
        >
          <Camera className="w-6 h-6" />
          Ambil Foto
        </button>
      ) : (
        <div className="flex gap-4">
          <button
            onClick={handleRetake}
            className="flex items-center gap-2 px-6 py-3 rounded-xl border-2 border-gray-300 text-gray-700 text-base font-semibold hover:bg-white/60 transition-all active:scale-95"
          >
            <RotateCcw className="w-4 h-4" />
            Ulangi
          </button>
          <button
            onClick={handleConfirm}
            disabled={submitted}
            className={`flex items-center gap-2 px-6 py-3 rounded-xl text-base font-bold shadow-lg transition-all active:scale-95 ${submitted ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-orange-500 hover:bg-orange-400 text-white'}`}
          >
            <Check className="w-4 h-4" />
            {submitted ? 'Mengirim...' : 'Konfirmasi'}
          </button>
        </div>
      ))}
    </div>
  )
}
