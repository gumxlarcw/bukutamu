import { useState, useEffect } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { waApi } from '@/api/wa'
import { evaluationsApi } from '@/api/evaluations'
import { EvaluationForm } from '@/components/kiosk/EvaluationForm'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import type { EvaluationSubmission } from '@/types/evaluation'

export default function EvaluasiOnlinePage() {
  const { id } = useParams<{ id: string }>()
  const [params] = useSearchParams()
  const accessToken = params.get('t') ?? ''
  const [evalToken, setEvalToken] = useState<string | undefined>()
  const [done, setDone] = useState(false)
  const [closed, setClosed] = useState(false)

  // Exchange the durable access token for a short eval-submit token.
  useEffect(() => {
    if (!id || !accessToken) return
    let cancelled = false
    waApi.getEvalToken(Number(id), accessToken)
      .then(r => { if (!cancelled) setEvalToken(r.data.data?.kiosk_token) })
      .catch((e) => { if (!cancelled) { if (e?.response?.status === 409) setClosed(true); } })
    return () => { cancelled = true }
  }, [id, accessToken])

  const { data: formData, isLoading } = useQuery({
    queryKey: ['wa-eval-form', id, evalToken],
    queryFn: () => evaluationsApi.getForm(Number(id), evalToken!).then(r => r.data.data),
    enabled: !!id && !!evalToken,
  })

  const submit = useMutation({
    mutationFn: (data: EvaluationSubmission) => evaluationsApi.submit(Number(id), data, evalToken!),
    onSuccess: () => setDone(true),
    onError: () => toast.error('Gagal mengirim evaluasi'),
  })

  if (!accessToken) return <p className="p-8 text-center">Tautan tidak valid.</p>
  if (closed) return <p className="p-8 text-center">Evaluasi untuk permintaan ini sudah ditutup. Terima kasih.</p>
  if (done) return <p className="p-8 text-center text-lg font-semibold">Terima kasih atas penilaian Anda! 🙏</p>
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
