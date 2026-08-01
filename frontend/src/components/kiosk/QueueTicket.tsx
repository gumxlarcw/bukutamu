import { Printer, Clock, User, LayoutGrid } from 'lucide-react'
import { useEffect, useState, useRef } from 'react'
import type { TicketData } from '@/api/kiosk'
import { parseLayanan } from '@/types/visit'

interface QueueTicketProps {
  ticket: TicketData
  onPrint?: () => void
  isPrinting?: boolean
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('id-ID', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function CountUpText({ text }: { text: string }) {
  const [display, setDisplay] = useState('')
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    let step = 0
    const interval = setInterval(() => {
      setDisplay(
        text
          .split('')
          .map((ch, i) => (i <= step ? ch : chars[Math.floor(Math.random() * chars.length)]))
          .join(''),
      )
      step++
      if (step >= text.length) clearInterval(interval)
    }, 60)
    return () => clearInterval(interval)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  return <>{display || text}</>
}

export function QueueTicket({ ticket, onPrint, isPrinting }: QueueTicketProps) {
  return (
    <div className="ticket-entrance bg-white/95 text-gray-800 rounded-2xl shadow-2xl px-6 py-4 max-w-sm w-full text-center overflow-hidden">
      <style>{`
        .ticket-entrance {
          animation: ticketPop 0.5s cubic-bezier(0.16, 1, 0.3, 1);
        }
        @keyframes ticketPop {
          from { opacity: 0; transform: scale(0.9) translateY(20px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
        .queue-number-glow {
          animation: numberGlow 2s ease-in-out infinite alternate;
        }
        @keyframes numberGlow {
          from { box-shadow: 0 0 20px rgba(249, 115, 22, 0.15); }
          to { box-shadow: 0 0 40px rgba(249, 115, 22, 0.3); }
        }
      `}</style>

      {/* Header */}
      <div className="mb-2">
        <p className="text-orange-600 font-semibold text-xs uppercase tracking-widest mb-0.5">
          Tiket Antrian
        </p>
        <h2 className="text-lg font-bold text-gray-900">BPS Provinsi Maluku Utara</h2>
      </div>

      {/* Queue number */}
      <div className="queue-number-glow bg-orange-50 border-2 border-orange-200 rounded-xl py-3 px-4 mb-3">
        <p className="text-orange-600 text-xs font-semibold mb-1">Nomor Antrian</p>
        {ticket.nomor_antrian ? (
          <p className="text-5xl font-black text-orange-600 leading-none">
            <CountUpText text={ticket.nomor_antrian} />
          </p>
        ) : (
          <p className="text-lg font-bold text-gray-500 italic">Langsung Dilayani</p>
        )}
      </div>

      {/* Details — horizontal layout */}
      <div className="flex gap-3 text-left mb-3">
        <div className="flex items-start gap-1.5 flex-1 min-w-0">
          <User className="w-3.5 h-3.5 text-orange-500 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-[10px] text-gray-500 font-medium uppercase">Nama</p>
            <p className="font-semibold text-gray-800 text-xs break-words leading-snug">{ticket.nama}</p>
          </div>
        </div>

        <div className="flex items-start gap-1.5 flex-1 min-w-0">
          <LayoutGrid className="w-3.5 h-3.5 text-orange-500 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-[10px] text-gray-500 font-medium uppercase">Layanan</p>
            {/* jenis_layanan datang sebagai JSON string, mis. '["Perpustakaan"]'.
                Dirender mentah, setiap pengunjung kiosk melihat tanda kurung dan
                tanda kutip di layar konfirmasi. AUDIT_2026-08-01 #15. */}
            <p className="font-semibold text-gray-800 text-xs break-words leading-snug">{parseLayanan(ticket.jenis_layanan).join(', ')}</p>
          </div>
        </div>

        <div className="flex items-start gap-1.5 flex-1 min-w-0">
          <Clock className="w-3.5 h-3.5 text-orange-500 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-[10px] text-gray-500 font-medium uppercase">Waktu</p>
            <p className="font-semibold text-gray-800 text-[10px] break-words leading-snug">{formatDateTime(ticket.date_visit)}</p>
          </div>
        </div>
      </div>

      {/* Print button */}
      {onPrint && (
        <button
          onClick={onPrint}
          disabled={isPrinting}
          className="flex items-center justify-center gap-2 w-full py-2 rounded-xl border-2 border-orange-500 text-orange-600 font-semibold text-sm hover:bg-orange-50 active:bg-orange-100 transition-all disabled:opacity-50"
        >
          <Printer className="w-4 h-4" />
          {isPrinting ? 'Mencetak...' : 'Cetak Ulang'}
        </button>
      )}
    </div>
  )
}
