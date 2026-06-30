import apiClient from './client'
import type { ApiResponse, PaginatedResponse } from '@/types/api'
import type { DataDelivery, DataDeliveryDetail, VerifDecision } from '@/types/delivery'

export const deliveriesApi = {
  list: (params: { status?: string; id_kunjungan?: number; page?: number; limit?: number }) =>
    apiClient.get<PaginatedResponse<DataDelivery>>('/api/deliveries', { params }),
  get: (id: number) =>
    apiClient.get<ApiResponse<DataDeliveryDetail>>(`/api/deliveries/${id}`),
  fileUrl: (id: number) => `/api/deliveries/${id}/file`,
  create: (fd: FormData, onProgress?: (pct: number) => void) =>
    apiClient.post<ApiResponse<DataDelivery>>('/api/deliveries', fd, {
      onUploadProgress: onProgress
        ? (e) => onProgress(Math.round((e.loaded * 100) / (e.total || 1)))
        : undefined,
    }),
  verify: (id: number, decision: VerifDecision, note?: string) =>
    apiClient.put<ApiResponse<DataDelivery>>(`/api/deliveries/${id}/verify`, { decision, note }),
  resubmit: (id: number, fd: FormData) =>
    apiClient.put<ApiResponse<DataDelivery>>(`/api/deliveries/${id}`, fd),
  cancel: (id: number) =>
    apiClient.delete<ApiResponse<null>>(`/api/deliveries/${id}`),
}
