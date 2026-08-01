import { useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { kioskApi } from '@/api/kiosk'
import { QueueTicket } from '@/components/kiosk/QueueTicket'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { usePrint } from '@/hooks/usePrint'
import { useInactivityTimeout } from '@/hooks/useInactivityTimeout'
import { Home } from 'lucide-react'

export default function TicketPage() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const { printTicket, isPrinting } = usePrint()

  // Satu-satunya halaman kiosk dalam grup KioskLayout yang TIDAK punya timeout —
  // tujuh saudaranya semua memasangnya. Padahal salinannya sendiri berbunyi
  // "Silakan tunggu panggilan", yang justru mengundang pengunjung pergi, sehingga
  // kiosk terparkir menampilkan nama lengkap + nomor antrian pengunjung sebelumnya
  // tanpa batas. 45 detik, lebih pendek dari 120 detik di halaman lain: layar ini
  // memuat data pribadi dan pengunjung hanya perlu membaca satu nomor.
  // AUDIT_2026-08-01 #16.
  useInactivityTimeout(() => navigate('/kiosk'), 45000)

  const { data: ticket, isLoading, isError } = useQuery({
    queryKey: ['ticket', id],
    queryFn: () => kioskApi.getTicket(Number(id)).then(r => r.data.data),
    enabled: !!id,
  })

  // Auto-print on mount when ticket data is available
  useEffect(() => {
    if (ticket) {
      printTicket({
        nomor_antrian: ticket.nomor_antrian,
        nama: ticket.nama,
        jenis_layanan: ticket.jenis_layanan,
        date_visit: ticket.date_visit,
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket?.id_kunjungan])

  const handleReprint = () => {
    if (ticket) {
      printTicket({
        nomor_antrian: ticket.nomor_antrian,
        nama: ticket.nama,
        jenis_layanan: ticket.jenis_layanan,
        date_visit: ticket.date_visit,
      })
    }
  }

  return (
    <div className="flex flex-col items-center text-gray-800 px-4 max-w-lg w-full mx-auto">
      {isLoading && (
        <div className="flex flex-col items-center gap-4">
          <LoadingSpinner />
          <p className="text-gray-500">Memuat tiket...</p>
        </div>
      )}

      {isError && (
        <div className="text-center">
          <p className="text-red-600 text-xl mb-6">Gagal memuat tiket</p>
          <button
            onClick={() => navigate('/kiosk')}
            className="px-8 py-4 bg-orange-500 rounded-xl text-white font-bold"
          >
            Mulai Ulang
          </button>
        </div>
      )}

      {ticket && (
        <>
          <h1 className="kiosk-enter text-2xl font-bold mb-3">Pendaftaran Berhasil!</h1>
          <div className="kiosk-enter" style={{ animationDelay: '200ms' }}>
            <QueueTicket ticket={ticket} onPrint={handleReprint} isPrinting={isPrinting} />
          </div>

          <button
            onClick={() => navigate('/kiosk')}
            className="kiosk-enter mt-3 flex items-center gap-2 px-6 py-3 rounded-xl bg-orange-500 hover:bg-orange-400 active:bg-orange-600 text-white text-base font-bold shadow-xl transition-all active:scale-95"
            style={{ animationDelay: '400ms' }}
          >
            <Home className="w-6 h-6" />
            Selesai
          </button>

          <p className="mt-2 text-gray-400 text-xs text-center">
            Silakan tunggu panggilan nomor antrian Anda
          </p>
        </>
      )}
    </div>
  )
}
