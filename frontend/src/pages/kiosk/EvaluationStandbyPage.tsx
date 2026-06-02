import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { evaluationsApi } from '@/api/evaluations'
import { parseLayanan } from '@/types/visit'
import { ClipboardList, UserCircle2, Hash, CalendarClock } from 'lucide-react'

// Dots dekoratif background. Di-generate sekali di module-scope supaya
// stabil lintas render (hindari react-hooks/purity warning untuk Math.random
// di useMemo factory, dan cegah flicker saat strict-mode double-render).
const DOTS = Array.from({ length: 12 }, (_, i) => ({
  width: Math.random() * 200 + 50,
  height: Math.random() * 200 + 50,
  left: Math.random() * 100,
  top: Math.random() * 100,
  delay: i * 0.4,
  duration: 3 + i * 0.5,
}))

// date_visit MySQL ("2026-06-02 08:18:17") → "02 Jun 2026, 08.18" (lokal WIT).
function fmtKunjungan(s: string | null): string {
  if (!s) return '-'
  const d = new Date(s.replace(' ', 'T'))
  if (isNaN(d.getTime())) return s
  return d.toLocaleString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export default function EvaluationStandbyPage() {
  const navigate = useNavigate()
  const [opening, setOpening] = useState(false)
  // Cegah mint token konkuren (auto-open + klik beruntun). Di-reset kalau gagal.
  const busyRef = useRef(false)

  // Poll daftar SEMUA yang menunggu evaluasi (SKD). staleTime/gcTime 0 supaya
  // setelah submit, daftar lama tidak langsung memicu navigate balik ke visit
  // yang baru saja selesai.
  const { data: list = [] } = useQuery({
    queryKey: ['evaluation-pending-list'],
    queryFn: () => evaluationsApi.getPendingList().then(r => r.data.data ?? []),
    refetchInterval: 5000,
    staleTime: 0,
    gcTime: 0,
  })

  // Buka form evaluasi untuk SATU visit: mint token spesifik lalu navigate dengan
  // token di route state (EvaluationPage memakainya untuk getForm + submit).
  const openEval = (id: number) => {
    if (busyRef.current) return
    busyRef.current = true
    setOpening(true)
    evaluationsApi
      .getPending(id)
      .then((r) => {
        const tok = r.data.data?.kiosk_token
        if (tok) {
          navigate(`/kiosk/evaluasi/${id}`, { state: { kiosk_token: tok } })
          return // biarkan busy=true sampai unmount; cegah double-open
        }
        // Visit tidak lagi eligible (sudah selesai) — biarkan poll berikutnya refresh.
        busyRef.current = false
        setOpening(false)
      })
      .catch(() => {
        busyRef.current = false
        setOpening(false)
      })
  }

  // Keputusan produk: kalau HANYA 1 yang menunggu → auto-buka langsung.
  // ≥2 → tampilkan kartu pemilihan (lihat render di bawah). 0 → layar standby.
  useEffect(() => {
    if (list.length === 1) openEval(list[0].id_kunjungan)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list])

  const containerStyle: React.CSSProperties = {
    width: 'calc(100vw / 1.75)',
    height: 'calc(100vh / 1.75)',
    zoom: 1.75,
    fontFamily: "'Outfit', system-ui, sans-serif",
  }

  // ── Mode kartu: ≥2 pengunjung menunggu, petugas/pengunjung pilih yang sesuai ──
  if (list.length >= 2) {
    return (
      <div
        // Scroll di kontainer luar (lihat EvaluationPage) — inner-flex-scroll
        // tidak reliabel di bawah CSS zoom saat kartu banyak.
        className="overflow-y-auto overflow-x-hidden flex flex-col bg-gradient-to-br from-orange-50 to-amber-100 text-gray-800 px-6 py-5"
        style={containerStyle}
      >
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap');`}</style>
        <div className="shrink-0 text-center mb-4">
          <h1 className="text-2xl md:text-3xl font-bold">Pilih Nama Anda</h1>
          <p className="text-gray-500 text-sm mt-1">
            Ada {list.length} pengunjung menunggu evaluasi — ketuk kartu sesuai nama &amp; waktu kunjungan Anda
          </p>
        </div>

        <div className="flex-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-3xl mx-auto pb-2">
            {list.map((item) => (
              <button
                key={item.id_kunjungan}
                type="button"
                disabled={opening}
                onClick={() => openEval(item.id_kunjungan)}
                className="text-left rounded-2xl bg-white/90 border-2 border-orange-200 hover:border-orange-400 hover:bg-white shadow-sm px-5 py-4 transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-full bg-orange-100 flex items-center justify-center shrink-0">
                    <UserCircle2 className="w-8 h-8 text-orange-600" strokeWidth={1.5} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-base font-bold text-gray-900 leading-tight truncate">
                      {item.nama || '(nama tidak tersedia)'}
                    </p>
                    <p className="text-xs text-gray-500 leading-tight truncate">
                      {item.nama_instansi || '(instansi tidak diisi)'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-2.5 flex-wrap">
                  {item.nomor_antrian && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-orange-50 border border-orange-200 text-orange-700 text-[11px] font-bold">
                      <Hash className="w-3 h-3" />
                      {item.nomor_antrian}
                    </span>
                  )}
                  {parseLayanan(item.jenis_layanan).map((l, i) => (
                    <span key={i} className="inline-block px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-[11px] font-medium">
                      {l}
                    </span>
                  ))}
                </div>
                <div className="flex items-center gap-1.5 mt-2 text-[11px] text-gray-500">
                  <CalendarClock className="w-3.5 h-3.5" />
                  <span>Kunjungan: {fmtKunjungan(item.date_visit)}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // ── Mode standby: 0 menunggu (atau 1 sedang auto-dibuka) ──
  return (
    <div
      className="overflow-hidden flex flex-col items-center justify-center bg-gradient-to-br from-orange-50 to-amber-100 text-gray-800 px-8"
      style={containerStyle}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap');
        .kiosk-enter { opacity:0; transform:translateY(20px); animation:kioskFadeUp 0.6s cubic-bezier(0.16,1,0.3,1) forwards; }
        @keyframes kioskFadeUp { to { opacity:1; transform:translateY(0); } }
      `}</style>
      {/* Animated background dots */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {DOTS.map((dot, i) => (
          <div
            key={i}
            className="absolute rounded-full bg-orange-300/10 animate-pulse"
            style={{
              width: `${dot.width}px`,
              height: `${dot.height}px`,
              left: `${dot.left}%`,
              top: `${dot.top}%`,
              animationDelay: `${dot.delay}s`,
              animationDuration: `${dot.duration}s`,
            }}
          />
        ))}
      </div>

      <div className="relative z-10 flex flex-col items-center text-center">
        {/* Icon with pulsing animation */}
        <div className="relative mb-5">
          <div className="absolute inset-0 rounded-full bg-orange-300/30 animate-ping" />
          <div className="relative w-24 h-24 rounded-full bg-orange-100 border-4 border-orange-400 flex items-center justify-center">
            <ClipboardList className="w-12 h-12 text-orange-500" />
          </div>
        </div>

        <h1 className="kiosk-enter text-3xl md:text-4xl font-bold mb-3">
          Terminal Evaluasi
        </h1>
        <p className="kiosk-enter text-lg text-gray-500 mb-3" style={{ animationDelay: '0.1s' }}>
          {opening ? 'Membuka formulir evaluasi...' : 'Menunggu pengunjung untuk mengisi evaluasi...'}
        </p>

        {/* Animated dots */}
        <div className="flex gap-2 mt-2">
          {[0, 1, 2].map(i => (
            <div
              key={i}
              className="w-3 h-3 rounded-full bg-orange-500 animate-bounce"
              style={{ animationDelay: `${i * 0.2}s` }}
            />
          ))}
        </div>

        <p className="mt-4 text-gray-400 text-xs">
          Halaman ini akan otomatis membuka formulir evaluasi saat dibutuhkan
        </p>
      </div>
    </div>
  )
}
