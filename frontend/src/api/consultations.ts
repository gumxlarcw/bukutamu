import apiClient from './client'
import type { ApiResponse, PaginatedResponse } from '@/types/api'
import type { Visit, ConsultationDataRow } from '@/types/visit'

export const consultationsApi = {
  list: (params?: {
    q?: string; status?: string; layanan?: string
    tahun?: string; bulan?: string; page?: number; limit?: number
  }) => apiClient.get<PaginatedResponse<Visit>>('/api/consultations', { params }),
  updateStatus: (id: number, status: string) =>
    apiClient.put<ApiResponse<Visit>>(`/api/consultations/${id}`, { status }),
  call: (id: number) => apiClient.post<ApiResponse<null>>(`/api/consultations/${id}/call`),
  testSound: (id: number) => apiClient.post<ApiResponse<null>>(`/api/consultations/${id}/test-sound`),
  getData: (id: number) =>
    apiClient.get<ApiResponse<ConsultationDataRow[]>>(`/api/consultations/${id}/data`),
  saveData: (id: number, payload: { kebutuhan_data: ConsultationDataRow[]; hasil_konsultasi?: string }) =>
    apiClient.post<ApiResponse<null>>(`/api/consultations/${id}/data`, payload),
}
