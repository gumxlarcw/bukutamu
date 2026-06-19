import { useState, useEffect } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { waApi } from '@/api/wa'
import { evaluationsApi } from '@/api/evaluations'
import { EvaluationForm } from '@/components/kiosk/EvaluationForm'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import type { EvaluationSubmission } from '@/types/evaluation'

/** Layar terima kasih setelah evaluasi terkirim — wajah tersenyum beranimasi (senyum digambar,
 *  memantul, berkedip) + emoji 😊, bergaya tiket sukses (tema oranye BPS). */
function ThankYouScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'linear-gradient(160deg,#fff7ed,#ffe7cc)' }}>
      <style>{`
        .ty-card { animation: tyPop .6s cubic-bezier(.16,1,.3,1); }
        @keyframes tyPop { from {opacity:0; transform:scale(.9) translateY(16px);} to {opacity:1; transform:scale(1) translateY(0);} }
        .ty-face { animation: tyBounce 2s ease-in-out infinite; transform-origin:center; }
        @keyframes tyBounce { 0%,100% {transform:translateY(0) rotate(0);} 25% {transform:translateY(-9px) rotate(-5deg);} 75% {transform:translateY(-9px) rotate(5deg);} }
        .ty-ring { animation: tyRing 2.2s ease-out infinite; }
        @keyframes tyRing { 0% {transform:scale(.8); opacity:.5;} 100% {transform:scale(1.55); opacity:0;} }
        .ty-smile { stroke-dasharray:70; stroke-dashoffset:70; animation: tyDraw 1s ease-out .4s forwards; }
        @keyframes tyDraw { to {stroke-dashoffset:0;} }
        .ty-eye { animation: tyBlink 3.4s infinite; transform-origin:center; transform-box:fill-box; }
        @keyframes tyBlink { 0%,92%,100% {transform:scaleY(1);} 96% {transform:scaleY(.1);} }
        .ty-emoji { display:inline-block; animation: tyEmoji 1.6s ease-in-out infinite; }
        @keyframes tyEmoji { 0%,100% {transform:scale(.9) rotate(-6deg);} 50% {transform:scale(1.15) rotate(6deg);} }
      `}</style>
      <div className="ty-card relative bg-white rounded-3xl shadow-2xl px-7 py-9 max-w-sm w-full text-center overflow-hidden">
        <div className="relative w-28 h-28 mx-auto mb-5">
          <span className="ty-ring absolute inset-0 rounded-full" style={{ background: 'radial-gradient(circle, rgba(245,158,11,.4), transparent 70%)' }} />
          <svg viewBox="0 0 100 100" className="ty-face relative w-28 h-28" role="img" aria-label="Wajah tersenyum">
            <circle cx="50" cy="50" r="44" fill="#FFD34E" stroke="#F59E0B" strokeWidth="3" />
            <circle className="ty-eye" cx="36" cy="42" r="5.5" fill="#7c3a00" />
            <circle className="ty-eye" cx="64" cy="42" r="5.5" fill="#7c3a00" />
            <path className="ty-smile" d="M30 60 Q50 82 70 60" fill="none" stroke="#7c3a00" strokeWidth="5" strokeLinecap="round" />
          </svg>
        </div>
        <p className="text-orange-600 font-semibold text-[11px] uppercase tracking-[0.2em] mb-1">Evaluasi Terkirim</p>
        <h1 className="text-2xl font-black text-gray-900 leading-tight">
          Terima kasih atas<br />penilaian Anda! <span className="ty-emoji">😊</span>
        </h1>
        <p className="text-sm text-gray-600 leading-relaxed mt-3">
          Masukan Anda sangat berarti untuk meningkatkan kualitas layanan data BPS Provinsi Maluku Utara.
        </p>
        <div className="mt-5 text-[11px] text-gray-400 border-t border-dashed border-gray-300 pt-3">
          Anda dapat menutup halaman ini.
        </div>
      </div>
    </div>
  )
}

export default function EvaluasiOnlinePage() {
  const { id } = useParams<{ id: string }>()
  const [params] = useSearchParams()
  const accessToken = params.get('t') ?? ''
  const [evalToken, setEvalToken] = useState<string | undefined>()
  const [evalId, setEvalId] = useState<number | undefined>()
  const [done, setDone] = useState(false)
  const [closed, setClosed] = useState(false)
  const [failed, setFailed] = useState(false)

  // Exchange the durable access token for a short eval-submit token. The server may smart-route an
  // old session's link to the visitor's CURRENT pending eval, so trust the id_kunjungan it returns
  // (not the URL id) for the form fetch + submit — the eval-submit token is bound to that resolved id.
  useEffect(() => {
    if (!id || !accessToken) return
    let cancelled = false
    waApi.getEvalToken(Number(id), accessToken)
      .then(r => { if (!cancelled) { setEvalToken(r.data.data?.kiosk_token); setEvalId(r.data.data?.id_kunjungan) } })
      .catch((e) => { if (!cancelled) { if (e?.response?.status === 409) setClosed(true); else setFailed(true) } })
    return () => { cancelled = true }
  }, [id, accessToken])

  const { data: formData, isLoading, isError } = useQuery({
    queryKey: ['wa-eval-form', evalId, evalToken],
    queryFn: () => evaluationsApi.getForm(evalId!, evalToken!).then(r => r.data.data),
    enabled: !!evalId && !!evalToken,
  })

  const submit = useMutation({
    mutationFn: (data: EvaluationSubmission) => evaluationsApi.submit(evalId!, data, evalToken!),
    onSuccess: () => setDone(true),
    onError: () => toast.error('Gagal mengirim evaluasi'),
  })

  if (!accessToken) return <p className="p-8 text-center">Tautan tidak valid.</p>
  if (closed) return <p className="p-8 text-center">Evaluasi untuk permintaan ini sudah ditutup. Terima kasih.</p>
  if (done) return <ThankYouScreen />
  if (failed || isError) return <p className="p-8 text-center">Tautan evaluasi tidak valid atau sudah kadaluarsa. Silakan hubungi petugas layanan.</p>
  if (isLoading || !formData) return <LoadingSpinner className="min-h-screen" />

  return (
    <div className="max-w-md mx-auto p-4">
      <h1 className="text-lg font-bold text-center mb-4">Evaluasi Layanan</h1>
      <EvaluationForm
        indicators={formData.indicators}
        konsultasiKualitas={formData.konsultasiKualitas}
        onSubmit={(d) => submit.mutate(d)}
        isSubmitting={submit.isPending}
      />
    </div>
  )
}
