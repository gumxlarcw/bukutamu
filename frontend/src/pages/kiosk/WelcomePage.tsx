import { useNavigate } from 'react-router-dom'
import { useInactivityTimeout } from '@/hooks/useInactivityTimeout'
import { useEffect, useState, useMemo } from 'react'
import VideoSlideshow from '@/components/kiosk/VideoSlideshow'

// ─── Official SE2026 taglines from BPS ───
const SE_TAGLINES = [
  'Untuk Kesejahteraan Kita, Untuk Indonesia',
  'Data Anda adalah kekuatan ekonomi bangsa',
  'Mencatat seluruh usaha dan perusahaan di Indonesia',
  'Fondasi penting bagi perumusan kebijakan ekonomi nasional',
  'Dukung pembangunan ekonomi daerah melalui data yang akurat',
  '#SE2026 #MencatatIndonesia #DataMencerdaskanBangsa',
]

// ─── SE2026 period: 1 May – 31 August 2026 ───
const SE_START = new Date('2026-05-01T00:00:00+0800')
const SE_END = new Date('2026-08-31T23:59:59+0800')

function useCountdown() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  if (now >= SE_END) return { status: 'ended' as const, days: 0, hours: 0, minutes: 0, seconds: 0 }
  if (now >= SE_START) {
    const diff = SE_END.getTime() - now.getTime()
    return { status: 'active' as const, days: Math.floor(diff / 86400000), hours: Math.floor((diff % 86400000) / 3600000), minutes: Math.floor((diff % 3600000) / 60000), seconds: Math.floor((diff % 60000) / 1000) }
  }
  const diff = SE_START.getTime() - now.getTime()
  return { status: 'upcoming' as const, days: Math.floor(diff / 86400000), hours: Math.floor((diff % 86400000) / 3600000), minutes: Math.floor((diff % 3600000) / 60000), seconds: Math.floor((diff % 60000) / 1000) }
}

function useTaglineRotation(interval = 5000) {
  const [index, setIndex] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setIndex(i => (i + 1) % SE_TAGLINES.length), interval)
    return () => clearInterval(id)
  }, [interval])
  return index
}

export default function WelcomePage() {
  const navigate = useNavigate()
  const [mounted, setMounted] = useState(false)
  const countdown = useCountdown()
  const taglineIdx = useTaglineRotation()

  useInactivityTimeout(() => navigate('/kiosk'), 120000)

  const [hintReady, setHintReady] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 100)
    // Hint pulse starts after w-fade entrance completes (850ms delay + 700ms transition)
    const h = setTimeout(() => setHintReady(true), 1650)
    return () => { clearTimeout(t); clearTimeout(h) }
  }, [])

  const countdownLabel = useMemo(() => {
    if (countdown.status === 'ended') return 'Sensus Ekonomi 2026 telah berakhir'
    if (countdown.status === 'active') return 'Sedang berlangsung!'
    return 'Akan dimulai dalam'
  }, [countdown.status])

  return (
    <>
      <style>{`
        .w-fade { opacity:0; transform:translateY(16px); transition:all 0.7s cubic-bezier(0.16,1,0.3,1); }
        .w-fade.show { opacity:1; transform:translateY(0); }

        /* ── Brand strip ── */
        .brand-strip {
          padding: 20px 24px;
          position: relative;
        }
        .brand-strip::after {
          content: '';
          position: absolute;
          right: 0;
          top: 15%;
          bottom: 15%;
          width: 1px;
          background: linear-gradient(to bottom, transparent, rgba(42,32,22,0.06), transparent);
        }
        @media (max-width: 1023px) {
          .brand-strip::after { display: none; }
        }

        .divider-glow {
          height: 1px;
          background: linear-gradient(90deg, transparent, rgba(249,115,22,0.5), transparent);
          width: 0;
          transition: width 0.8s cubic-bezier(0.16,1,0.3,1);
        }
        .divider-glow.show { width: 60px; }

        .cta-btn {
          position: relative; overflow: hidden;
          opacity:0; transform:translateY(16px);
          transition: opacity 0.7s ease, transform 0.7s cubic-bezier(0.16,1,0.3,1);
        }
        .cta-btn.show { opacity:1; transform:translateY(0); }
        .cta-btn::before {
          content:''; position:absolute; inset:-2px; border-radius:16px;
          background:linear-gradient(135deg,rgba(249,115,22,0.3),rgba(245,166,35,0.2),rgba(249,115,22,0.3));
          z-index:-1; animation:btnGlow 3s ease-in-out infinite alternate;
        }
        @keyframes btnGlow { 0%{opacity:0.4;filter:blur(8px)} 100%{opacity:0.7;filter:blur(10px)} }
        .cta-btn .shimmer {
          position:absolute; top:0; left:-100%; width:100%; height:100%;
          background:linear-gradient(90deg,transparent,rgba(255,255,255,0.4),transparent);
          animation:shimmer 4s ease-in-out infinite;
        }
        @keyframes shimmer { 0%,100%{left:-100%} 50%{left:100%} }

        .hint-pulse { animation:none; }
        .hint-pulse.active { animation:hintPulse 3s ease-in-out infinite; }
        @keyframes hintPulse { 0%,100%{opacity:0.35} 50%{opacity:0.6} }

        /* ── Promo column ── */
        .promo-card {
          border-radius: 16px;
          overflow: hidden;
          border: 1px solid rgba(42,32,22,0.08);
          box-shadow: 0 8px 32px rgba(42,32,22,0.08);
        }
        .tagline-fade-enter { animation: tagFadeIn 0.6s ease-out; }
        @keyframes tagFadeIn { from{opacity:0;filter:blur(6px);transform:translateY(6px)} to{opacity:1;filter:blur(0);transform:translateY(0)} }

        /* ── Countdown ── */
        .cd-row { display:flex; align-items:flex-start; justify-content:center; gap:2px; }
        .cd-unit { display:flex; flex-direction:column; align-items:center; min-width:48px; }
        .cd-unit .val { font-size:24px; font-weight:800; line-height:1; font-variant-numeric:tabular-nums; }
        .cd-unit .lbl { font-size:9px; font-weight:500; text-transform:uppercase; letter-spacing:0.06em; margin-top:3px; opacity:0.5; }
        .cd-sep { font-size:18px; font-weight:700; opacity:0.25; padding:0 1px; line-height:1; margin-top:2px; }
      `}</style>

      <div className="relative flex items-center justify-center text-gray-800 w-full select-none">

        {/* ═══ Asymmetric layout: 35% brand | 65% promo ═══ */}
        <div className="relative z-10 flex flex-col lg:flex-row items-stretch w-full gap-0">

          {/* ── LEFT: Brand strip (38%) ── */}
          <div className="brand-strip w-full lg:w-[32%] shrink-0 flex flex-col items-center justify-center text-center">

            {/* Logos stacked */}
            <div className={`w-fade flex items-center justify-center gap-3 mb-3 ${mounted ? 'show' : ''}`}>
              <img src="/logo-bps.png" alt="Logo BPS" className="h-12 w-auto object-contain drop-shadow-lg" onError={e => { e.currentTarget.style.display = 'none' }} />
              <div className="h-8 w-px bg-gray-300" />
              <img src="/logo-se2026.png?v=2" alt="Logo SE2026" className="h-11 w-auto object-contain drop-shadow-lg" onError={e => { e.currentTarget.style.display = 'none' }} />
            </div>

            {/* Title */}
            <p className={`w-fade text-xs font-medium tracking-[0.2em] uppercase text-orange-500/70 mb-2 ${mounted ? 'show' : ''}`} style={{ transitionDelay: '150ms' }}>
              Selamat Datang di
            </p>
            <h1 className={`w-fade text-2xl lg:text-3xl font-extrabold leading-tight tracking-tight text-gray-800 mb-1 ${mounted ? 'show' : ''}`} style={{ transitionDelay: '300ms', margin: 0 }}>
              BPS Provinsi
            </h1>
            <h1 className={`w-fade text-2xl lg:text-3xl font-extrabold leading-tight tracking-tight mb-0 ${mounted ? 'show' : ''}`} style={{ transitionDelay: '400ms', margin: 0 }}>
              <span className="bg-gradient-to-r from-orange-600 via-amber-600 to-orange-500 bg-clip-text text-transparent">Maluku Utara</span>
            </h1>

            {/* Divider */}
            <div className={`divider-glow mx-auto my-3 ${mounted ? 'show' : ''}`} style={{ transitionDelay: '500ms' }} />

            {/* Countdown */}
            <div className={`w-fade mb-3 ${mounted ? 'show' : ''}`} style={{ transitionDelay: '550ms' }}>
              <p className="text-[11px] font-bold text-orange-600/80 uppercase tracking-[0.1em] mb-1">
                Sensus Ekonomi 2026
              </p>
              <p className="text-[10px] text-gray-500 leading-relaxed mb-2 max-w-[220px] mx-auto">
                Pendataan seluruh usaha & perusahaan non-pertanian di Indonesia
              </p>
              <p className="text-[11px] font-bold text-gray-500 uppercase tracking-[0.1em] mb-2">
                {countdownLabel}
              </p>
              {countdown.status !== 'ended' && (
                <div className="cd-row">
                  <CdUnit value={countdown.days} label="Hari" color={countdown.status === 'active' ? 'text-amber-600' : 'text-orange-600'} />
                  <span className="cd-sep">:</span>
                  <CdUnit value={countdown.hours} label="Jam" color={countdown.status === 'active' ? 'text-amber-600' : 'text-orange-600'} />
                  <span className="cd-sep">:</span>
                  <CdUnit value={countdown.minutes} label="Menit" color={countdown.status === 'active' ? 'text-amber-600' : 'text-orange-600'} />
                  <span className="cd-sep">:</span>
                  <CdUnit value={countdown.seconds} label="Detik" color={countdown.status === 'active' ? 'text-amber-600' : 'text-orange-600'} />
                </div>
              )}
              <p className="text-[11px] font-medium text-gray-400 mt-2">
                1 Mei – 31 Agustus 2026
              </p>
              {countdown.status === 'active' && (
                <div className="flex items-center justify-center gap-1.5 mt-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                  <span className="text-green-600 text-[11px] font-semibold">Sedang berlangsung</span>
                </div>
              )}
            </div>

            {/* CTA */}
            <button
              onClick={() => navigate('/kiosk/service')}
              className={`cta-btn w-full max-w-[220px] py-3 text-sm font-bold rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 active:from-orange-600 active:to-amber-600 text-white shadow-xl shadow-orange-500/20 transition-colors duration-200 active:scale-95 cursor-pointer ${mounted ? 'show' : ''}`}
              style={{ transitionDelay: '650ms' }}
            >
              <span className="shimmer" />
              <span className="relative z-10 flex items-center justify-center gap-2">
                Isi Buku Tamu
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </span>
            </button>

            {/* WA check-in — identity-first shortcut. Kept directly under the primary CTA so the
                two actions read as a pair; the hint below applies to both. */}
            <button
              onClick={() => navigate('/kiosk/wa-checkin')}
              className={`w-fade w-full max-w-[220px] mt-3 py-2.5 text-sm font-semibold rounded-xl border-2 border-orange-400 text-orange-600 hover:bg-orange-50 active:bg-orange-100 transition-colors duration-200 active:scale-95 cursor-pointer flex items-center justify-center gap-2 ${mounted ? 'show' : ''}`}
              style={{ transitionDelay: '850ms' }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg>
              Sudah Daftar via WhatsApp
            </button>

            <p className={`w-fade text-xs text-gray-400 mt-3 font-medium tracking-wide ${mounted ? 'show' : ''} hint-pulse ${hintReady ? 'active' : ''}`} style={{ transitionDelay: '950ms' }}>
              Klik atau sentuh untuk mengisi buku tamu
            </p>
          </div>

          {/* ── RIGHT: Promo column (62%) ── */}
          <div className={`w-fade w-full lg:w-[68%] flex flex-col items-center justify-center py-4 lg:px-6 ${mounted ? 'show' : ''}`} style={{ transitionDelay: '500ms' }}>

            {/* Video + Tagline */}
            <div className="promo-card w-full">
              <VideoSlideshow />

              {/* White tagline area */}
              <div style={{ background: '#fff', borderRadius: '0 0 20px 20px', padding: '10px 16px' }}>
                <div className="flex items-center gap-2 mb-1">
                  <img src="/logo-se2026.png?v=2" alt="" className="h-3.5 w-auto shrink-0" onError={e => { e.currentTarget.style.display = 'none' }} />
                  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#c4570a' }}>Sensus Ekonomi 2026</span>
                </div>
                <p style={{ fontSize: 11, fontWeight: 500, lineHeight: 1.4, color: '#2a2016' }} className="tagline-fade-enter" key={taglineIdx}>
                  {SE_TAGLINES[taglineIdx]}
                </p>
              </div>
            </div>

            {/* Hashtags */}
            <div className="flex items-center justify-center gap-3 mt-3">
              {['#SE2026', '#MencatatIndonesia', '#DataMencerdaskanBangsa'].map(tag => (
                <span key={tag} className="text-[10px] font-semibold text-orange-500/50 tracking-wide">{tag}</span>
              ))}
            </div>

          </div>

        </div>
      </div>
    </>
  )
}

function CdUnit({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div className="cd-unit">
      <span className={`val ${color}`}>{String(value).padStart(2, '0')}</span>
      <span className="lbl text-gray-600">{label}</span>
    </div>
  )
}
