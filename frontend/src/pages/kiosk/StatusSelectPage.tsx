import { useNavigate, useLocation } from 'react-router-dom'
import { useInactivityTimeout } from '@/hooks/useInactivityTimeout'
import { UserCheck, UserPlus, MessageCircle } from 'lucide-react'

export default function StatusSelectPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const visitState = location.state ?? {}
  useInactivityTimeout(() => navigate('/kiosk'), 120000)

  return (
    <div className="flex flex-col items-center text-center text-gray-800 px-4 max-w-4xl w-full mx-auto">
      <h1 className="kiosk-enter text-xl md:text-2xl font-bold mb-1">
        Apakah Anda Sudah Terdaftar?
      </h1>
      <p className="kiosk-enter text-gray-500 mb-4 text-sm" style={{ animationDelay: '100ms' }}>Pilih salah satu opsi di bawah ini</p>

      <div className="grid grid-cols-3 gap-5 w-full">
        {/* Returning visitor */}
        <button
          onClick={() => navigate('/kiosk/recognize', { state: visitState })}
          className="kiosk-enter group flex flex-col items-center justify-center gap-3 p-5 rounded-2xl overflow-hidden bg-white/70 hover:bg-orange-500 active:bg-orange-600 border-2 border-gray-200 hover:border-orange-400 backdrop-blur-sm shadow-lg hover:shadow-xl transition-all duration-200 transform hover:scale-105 active:scale-95 cursor-pointer hover:text-white"
          style={{ animationDelay: '200ms' }}
        >
          <div className="w-14 h-14 rounded-full bg-orange-100 group-hover:bg-white/20 flex items-center justify-center transition-colors">
            <UserCheck className="w-7 h-7 text-orange-500 group-hover:text-white" />
          </div>
          <div>
            <h2 className="text-lg font-bold mb-0.5">Sudah Pernah Daftar</h2>
            <p className="text-gray-500 group-hover:text-white/90 text-sm">
              Kenali wajah saya untuk melanjutkan
            </p>
          </div>
        </button>

        {/* New visitor */}
        <button
          onClick={() => navigate('/kiosk/form', { state: visitState })}
          className="kiosk-enter group flex flex-col items-center justify-center gap-3 p-5 rounded-2xl overflow-hidden bg-white/70 hover:bg-orange-500 active:bg-orange-600 border-2 border-gray-200 hover:border-orange-400 backdrop-blur-sm shadow-lg hover:shadow-xl transition-all duration-200 transform hover:scale-105 active:scale-95 cursor-pointer hover:text-white"
          style={{ animationDelay: '350ms' }}
        >
          <div className="w-14 h-14 rounded-full bg-orange-100 group-hover:bg-white/20 flex items-center justify-center transition-colors">
            <UserPlus className="w-7 h-7 text-orange-500 group-hover:text-white" />
          </div>
          <div>
            <h2 className="text-lg font-bold mb-0.5">Belum Pernah Daftar</h2>
            <p className="text-gray-500 group-hover:text-white/90 text-sm">
              Daftarkan diri sebagai pengunjung baru
            </p>
          </div>
        </button>

        {/* WA online registrant — phone + face only */}
        <button
          onClick={() => navigate('/kiosk/wa-checkin', { state: visitState })}
          className="kiosk-enter group flex flex-col items-center justify-center gap-3 p-5 rounded-2xl overflow-hidden bg-white/70 hover:bg-orange-500 active:bg-orange-600 border-2 border-gray-200 hover:border-orange-400 backdrop-blur-sm shadow-lg hover:shadow-xl transition-all duration-200 transform hover:scale-105 active:scale-95 cursor-pointer hover:text-white"
          style={{ animationDelay: '500ms' }}
        >
          <div className="w-14 h-14 rounded-full bg-orange-100 group-hover:bg-white/20 flex items-center justify-center transition-colors">
            <MessageCircle className="w-7 h-7 text-orange-500 group-hover:text-white" />
          </div>
          <div>
            <h2 className="text-lg font-bold mb-0.5">Sudah Daftar via WhatsApp</h2>
            <p className="text-gray-500 group-hover:text-white/90 text-sm">
              Masukkan nomor HP &amp; pindai wajah
            </p>
          </div>
        </button>
      </div>

      <div className="kiosk-enter flex gap-3 mt-4 w-full max-w-md" style={{ animationDelay: '500ms' }}>
        <button
          onClick={() => navigate('/kiosk/service', { state: visitState })}
          className="flex-1 px-4 py-3 rounded-xl border-2 border-gray-300 text-gray-700 text-sm font-semibold hover:bg-white/60 transition-all active:scale-95 cursor-pointer"
        >
          Kembali
        </button>
      </div>
    </div>
  )
}
