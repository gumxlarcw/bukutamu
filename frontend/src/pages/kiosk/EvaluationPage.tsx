import { useNavigate, useParams, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { evaluationsApi } from '@/api/evaluations'
import { EvaluationForm } from '@/components/kiosk/EvaluationForm'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { CheckCircle, UserCircle2, Hash, CalendarClock } from 'lucide-react'
import { parseLayanan } from '@/types/visit'
import type { EvaluationSubmission } from '@/types/evaluation'

// date_visit MySQL ("2026-06-02 08:18:17") → "02 Jun 2026, 08.18" (lokal WIT).
function fmtKunjungan(s: string | null): string {
  if (!s) return '-'
  const d = new Date(s.replace(' ', 'T'))
  if (isNaN(d.getTime())) return s
  return d.toLocaleString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export default function EvaluationPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const { id } = useParams<{ id: string }>()
  // Kiosk token covers both getForm and submit (10-min TTL). Dua sumber:
  // (1) route state dari EvaluationStandbyPage (auto-open / pilih kartu), atau
  // (2) deep-link langsung (tombol "Buka Evaluasi" admin) tanpa state → kita mint
  //     token untuk :id ini via /pending?id=. Kalau visit tidak lagi eligible
  //     (sudah selesai / bukan SKD), backend balas null → kita lempar ke standby.
  const stateToken = (location.state as { kiosk_token?: string } | null)?.kiosk_token
  const [resolvedToken, setResolvedToken] = useState<string | undefined>(stateToken)

  useEffect(() => {
    // Token dari route state sudah jadi nilai awal resolvedToken (useState di atas),
    // jadi cukup berhenti — tidak perlu setState lagi di sini.
    if (stateToken) return
    if (!id) {
      navigate('/kiosk/evaluasi', { replace: true })
      return
    }
    let cancelled = false
    evaluationsApi
      .getPending(Number(id))
      .then((r) => {
        if (cancelled) return
        const tok = r.data.data?.kiosk_token
        if (tok) setResolvedToken(tok)
        else navigate('/kiosk/evaluasi', { replace: true })
      })
      .catch(() => {
        if (!cancelled) navigate('/kiosk/evaluasi', { replace: true })
      })
    return () => {
      cancelled = true
    }
  }, [stateToken, id, navigate])

  const { data: formData, isLoading, isError } = useQuery({
    queryKey: ['evaluation-form', id, resolvedToken],
    queryFn: () => evaluationsApi.getForm(Number(id), resolvedToken!).then(r => r.data.data),
    enabled: !!id && !!resolvedToken,
  })

  const submitMutation = useMutation({
    mutationFn: (data: EvaluationSubmission) => {
      if (!resolvedToken) throw new Error('Sesi evaluasi kadaluarsa — kembali ke layar standby.')
      return evaluationsApi.submit(Number(id), data, resolvedToken)
    },
  })

  // Tampilkan "Terima Kasih!" 4 detik, baru kembali ke standby.
  // Hapus cache 'evaluation-pending' sebelum navigate — kalau tidak, StandbyPage
  // pakai data basi yang masih berisi visit ini dan langsung navigate balik ke
  // form yang sama (visit sudah selesai, submit kedua gagal / overwrite data).
  useEffect(() => {
    if (!submitMutation.isSuccess) return
    const t = setTimeout(() => {
      // Buang cache daftar pending supaya StandbyPage tidak langsung auto-navigate
      // balik ke visit ini (sudah 'selesai') dari data basi.
      queryClient.removeQueries({ queryKey: ['evaluation-pending-list'] })
      navigate('/kiosk/evaluasi')
    }, 4000)
    return () => clearTimeout(t)
  }, [submitMutation.isSuccess, navigate, queryClient])

  return (
    <div
      className="flex flex-col overflow-hidden"
      style={{
        width: 'calc(100vw / 1.75)',
        height: 'calc(100vh / 1.75)',
        zoom: 1.75,
        fontFamily: "'Outfit', system-ui, sans-serif",
        background: 'linear-gradient(135deg, #f8f5f0 0%, #fef3ec 25%, #f0f4f8 50%, #fdf6ee 75%, #f8f5f0 100%)',
        backgroundSize: '400% 400%',
        animation: 'gradientShift 15s ease infinite',
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap');
        @keyframes gradientShift {
          0% { background-position: 0% 50%; }
          25% { background-position: 100% 0%; }
          50% { background-position: 100% 100%; }
          75% { background-position: 0% 100%; }
          100% { background-position: 0% 50%; }
        }
        .kiosk-enter {
          opacity: 0;
          transform: translateY(20px);
          animation: kioskFadeUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        @keyframes kioskFadeUp {
          to { opacity: 1; transform: translateY(0); }
        }
        .kiosk-scroll { overflow-y: auto; -webkit-overflow-scrolling: touch; }
        .kiosk-scroll::-webkit-scrollbar { display: none; }
        .kiosk-scroll { -ms-overflow-style: none; scrollbar-width: none; }
      `}</style>

      {/* Header */}
      <header className="kiosk-enter shrink-0 px-6 py-4 text-center">
        <h1 className="text-xl font-bold text-gray-800">
          Formulir Evaluasi Layanan
        </h1>
        <p className="text-gray-500 text-sm mt-1">
          Bantu kami meningkatkan kualitas pelayanan
        </p>
      </header>

      {/* Visitor confirmation banner — mencegah tamu salah submit form milik orang lain.
          Tampilkan nama, instansi, no antrian, dan layanan dengan visual prominent. */}
      {formData?.visitor && !submitMutation.isSuccess && (
        <section className="kiosk-enter shrink-0 px-4 pb-3" style={{ animationDelay: '80ms' }}>
          <div className="max-w-2xl mx-auto rounded-2xl bg-white/85 border-2 border-orange-300 shadow-sm px-5 py-4">
            <p className="text-[11px] font-bold uppercase tracking-widest text-orange-600 text-center mb-2">
              Konfirmasi Identitas — pastikan ini benar Anda
            </p>
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-full bg-orange-100 flex items-center justify-center shrink-0">
                <UserCircle2 className="w-9 h-9 text-orange-600" strokeWidth={1.5} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-lg font-bold text-gray-900 leading-tight truncate">
                  {formData.visitor.nama || '(nama tidak tersedia)'}
                </p>
                <p className="text-sm text-gray-600 leading-tight truncate">
                  {formData.visitor.nama_instansi || '(instansi tidak diisi)'}
                </p>
                <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                  {formData.visitor.nomor_antrian && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-orange-50 border border-orange-200 text-orange-700 text-[11px] font-bold">
                      <Hash className="w-3 h-3" />
                      {formData.visitor.nomor_antrian}
                    </span>
                  )}
                  {formData.visitor.jenis_layanan && parseLayanan(formData.visitor.jenis_layanan).map((l, i) => (
                    <span key={i} className="inline-block px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-[11px] font-medium">
                      {l}
                    </span>
                  ))}
                </div>
                <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-gray-500">
                  <CalendarClock className="w-3.5 h-3.5" />
                  <span>Waktu kunjungan: {fmtKunjungan(formData.visitor.date_visit)}</span>
                </div>
              </div>
            </div>
            <p className="text-[11px] text-center text-gray-500 mt-3">
              Bila nama atau antrian di atas <strong>BUKAN milik Anda</strong>, jangan submit — hubungi petugas.
            </p>
          </div>
        </section>
      )}

      <main className="flex-1 min-h-0 px-4 pb-4 max-w-2xl mx-auto w-full kiosk-scroll">
        {isLoading && (
          <div className="flex flex-col items-center gap-4 py-16">
            <LoadingSpinner />
            <p className="text-gray-400">Memuat formulir evaluasi...</p>
          </div>
        )}

        {isError && (
          <div className="text-center py-16">
            <p className="text-red-600 text-xl mb-6">Gagal memuat formulir evaluasi</p>
            <button
              onClick={() => navigate('/kiosk/evaluasi')}
              className="px-8 py-4 bg-orange-500 rounded-xl text-white font-bold hover:bg-orange-400 active:scale-95 transition-all"
            >
              Kembali
            </button>
          </div>
        )}

        {submitMutation.isSuccess && (
          <div className="kiosk-enter text-center py-16">
            <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-orange-100 border-2 border-orange-300 flex items-center justify-center">
              <CheckCircle className="w-10 h-10 text-orange-500" />
            </div>
            <h2 className="text-2xl font-bold text-gray-800 mb-2">Terima Kasih!</h2>
            <p className="text-gray-500">Evaluasi Anda telah berhasil dikirim.</p>
          </div>
        )}

        {formData && !submitMutation.isSuccess && (
          <div className="kiosk-enter" style={{ animationDelay: '150ms' }}>
            <EvaluationForm
              indicators={formData.indicators}
              konsultasiKualitas={formData.konsultasiKualitas}
              onSubmit={data => submitMutation.mutate(data)}
              isSubmitting={submitMutation.isPending}
            />
          </div>
        )}

        {submitMutation.isError && (
          <div className="mt-4 p-4 rounded-xl bg-red-50 border border-red-200 text-red-600 text-center">
            Gagal mengirim evaluasi. Silakan coba lagi.
          </div>
        )}
      </main>
    </div>
  )
}
