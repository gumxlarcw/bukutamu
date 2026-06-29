import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useInactivityTimeout } from '@/hooks/useInactivityTimeout'
import { ServiceSaranaSelector } from '@/components/kiosk/ServiceSaranaSelector'
import type { ServiceSaranaSelectorValue } from '@/components/kiosk/ServiceSaranaSelector'

export default function ServiceSelectPage() {
  const navigate = useNavigate()
  const [value, setValue] = useState<ServiceSaranaSelectorValue>({
    jenis_layanan: [],
    layanan_lainnya: '',
    sarana: [],
    sarana_lainnya: '',
  })

  useInactivityTimeout(() => navigate('/kiosk'), 120000)

  const isValid =
    value.jenis_layanan.length > 0 &&
    (!value.jenis_layanan.includes('Lainnya') || value.layanan_lainnya.trim() !== '') &&
    value.sarana.length > 0 &&
    (!value.sarana.includes(32) || value.sarana_lainnya.trim() !== '')

  const handleNext = () => {
    if (!isValid) return
    navigate('/kiosk/status', {
      state: {
        jenis_layanan: value.jenis_layanan,
        layanan_lainnya: value.layanan_lainnya,
        sarana: value.sarana,
        sarana_lainnya: value.sarana_lainnya,
      },
    })
  }

  return (
    <div className="flex flex-col text-gray-800 w-full max-w-4xl mx-auto h-full">
      {/* Header */}
      <div className="shrink-0 text-center px-4 pb-2">
        <h1 className="kiosk-enter text-xl font-bold mb-0.5">Layanan & Sarana</h1>
        <p className="kiosk-enter text-gray-500 text-[10px] leading-snug" style={{ animationDelay: '100ms' }}>
          Pertanyaan berikut merujuk pada periode <span className="font-semibold text-gray-700">1 Januari {new Date().getFullYear()}</span> hingga saat ini.
          <br />Pilih layanan dan sarana yang pernah Anda gunakan (boleh lebih dari satu).
        </p>
      </div>

      {/* Scrollable content */}
      <div className="kiosk-enter kiosk-scroll flex-1 min-h-0 px-4" style={{ animationDelay: '200ms' }}>
        <ServiceSaranaSelector value={value} onChange={setValue} />
      </div>

      {/* Footer buttons */}
      <div className="shrink-0 flex gap-3 px-4 pt-3 pb-1">
        <button
          onClick={() => navigate('/kiosk')}
          className="flex-1 px-4 py-3 rounded-xl border-2 border-gray-300 text-gray-700 text-sm font-semibold hover:bg-white/60 transition-all active:scale-95 cursor-pointer"
        >
          Kembali
        </button>
        <button
          onClick={handleNext}
          disabled={!isValid}
          className={`flex-1 px-4 py-3 rounded-xl text-sm font-bold transition-all active:scale-95
            ${isValid
              ? 'bg-orange-500 hover:bg-orange-400 text-white shadow-xl cursor-pointer'
              : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
        >
          Lanjut
        </button>
      </div>
    </div>
  )
}
