import apiClient from './client'
import type { ApiResponse } from '@/types/api'
import type {
  EvaluationIndicator,
  EvaluationSubmission,
  EvaluationResult,
  EvaluationFormData,
  EvaluationVisitor,
  EvaluationPendingItem,
  KonsultasiKualitas,
} from '@/types/evaluation'

interface EvaluationFormBackendShape {
  indikator: Record<string, string>
  evaluation: unknown[]
  konsultasi_kualitas: KonsultasiKualitas[]
  visitor: EvaluationVisitor | null
}

export const evaluationsApi = {
  // /pending now returns a kiosk_token (10 min) bound to id_kunjungan.
  // Tablet stores it and passes via X-Kiosk-Token header on both getForm
  // and submit — the form fetch + the submission share the same token.
  // Tanpa id → FIFO (visit terlama). Dengan id → mint token untuk visit spesifik
  // itu kalau masih eligible (dipakai deep-link admin + pilih kartu di standby).
  getPending: (id?: number) =>
    apiClient.get<ApiResponse<{ id_kunjungan: number; kiosk_token: string } | null>>(
      '/api/evaluations/pending',
      id != null ? { params: { id } } : undefined,
    ),
  // Daftar semua visit yang menunggu evaluasi (SKD) untuk kartu pemilihan.
  getPendingList: () =>
    apiClient.get<ApiResponse<EvaluationPendingItem[]>>('/api/evaluations/pending-list'),
  getForm: async (id: number, kiosk_token: string) => {
    const r = await apiClient.get<ApiResponse<EvaluationFormBackendShape>>(`/api/evaluations/${id}`, {
      headers: { 'X-Kiosk-Token': kiosk_token },
    })
    const indikator = r.data.data?.indikator ?? {}
    const indicators: EvaluationIndicator[] = Object.entries(indikator).map(([key, label]) => ({
      id: Number(key),
      label,
      satisfaction: 0,
    }))
    const konsultasiKualitas: KonsultasiKualitas[] = (r.data.data?.konsultasi_kualitas ?? []).map(k => ({
      id: Number(k.id),
      rincian_data: k.rincian_data ?? '',
      status_data: Number(k.status_data),
      kualitas: k.kualitas !== null && k.kualitas !== undefined ? Number(k.kualitas) : null,
    }))
    const visitor = r.data.data?.visitor ?? null
    const formData: EvaluationFormData = { indicators, konsultasiKualitas, visitor }
    return { ...r, data: { ...r.data, data: formData } }
  },
  submit: (id: number, data: EvaluationSubmission, kiosk_token: string) => {
    const payload = {
      skor_keseluruhan: data.overall_score,
      kepuasan: Object.fromEntries(data.indicators.map(i => [i.id, i.satisfaction])),
      kualitas_per_konsultasi: data.kualitas_per_konsultasi ?? {},
    }
    return apiClient.post<ApiResponse<null>>(`/api/evaluations/${id}`, payload, {
      headers: { 'X-Kiosk-Token': kiosk_token },
    })
  },
  getResults: (id: number) =>
    apiClient.get<ApiResponse<EvaluationResult>>(`/api/evaluations/${id}/results`),
  getSummary: (params?: { tahun?: string }) =>
    apiClient.get<ApiResponse<EvaluationSummary>>('/api/evaluations/summary', { params }),
}

export interface EvaluationSummaryVisit {
  id_kunjungan: number
  nama: string
  jenis_layanan: string
  date_visit: string
  rating_pengunjung: number | null
  avg_kepentingan: number
  avg_kepuasan: number
  jumlah_indikator: number
}

export interface EvaluationSummaryIndicator {
  indikator_id: number
  avg_kepentingan: number
  avg_kepuasan: number
  responden: number
}

export interface EvaluationSummaryMonthly {
  bulan: number
  ikm_score: number | string
  responden: number | string
}

export interface EvaluationSummaryQuarterly {
  triwulan: number
  ikm_score: number | string
  responden: number | string
}

export interface EvaluationSummary {
  visits: EvaluationSummaryVisit[]
  indicators: EvaluationSummaryIndicator[]
  overall: { ikm_score: number; total_responden: number }
  monthly: EvaluationSummaryMonthly[]
  quarterly: EvaluationSummaryQuarterly[]
  labels: Record<string, string>
}
