import apiClient from './client'
import type { ApiResponse, PaginatedResponse } from '@/types/api'
import type { Visit, DtsenDataRow } from '@/types/visit'

export const dtsenApi = {
  list: (params?: {
    q?: string; status?: string
    tahun?: string; bulan?: string; page?: number; limit?: number
  }) => apiClient.get<PaginatedResponse<Visit>>('/api/dtsen', { params }),
  updateStatus: (id: number, status: string) =>
    apiClient.put<ApiResponse<Visit>>(`/api/dtsen/${id}`, { status }),
  getData: (id: number) =>
    apiClient.get<ApiResponse<DtsenDataRow | null>>(`/api/dtsen/${id}/data`),
  saveData: (id: number, payload: Omit<DtsenDataRow, 'id' | 'id_kunjungan' | 'tanggal_input'>) =>
    apiClient.post<ApiResponse<DtsenDataRow>>(`/api/dtsen/${id}/data`, payload),
}
