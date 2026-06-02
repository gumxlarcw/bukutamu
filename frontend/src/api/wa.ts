import apiClient from './client'
import type { ApiResponse } from '@/types/api'
import type { WaSessionPrefill, WaIntakePayload, WaInboxRow } from '@/types/wa'

export const waApi = {
  getSession: (sessionId: number, token: string) =>
    apiClient.get<ApiResponse<WaSessionPrefill>>(`/api/wa/session/${sessionId}`, {
      headers: { 'X-Kiosk-Token': token },
    }),
  submitSession: (sessionId: number, token: string, payload: WaIntakePayload) =>
    apiClient.post<ApiResponse<{ id_kunjungan: number; ticket: string }>>(
      `/api/wa/session/${sessionId}`, payload, { headers: { 'X-Kiosk-Token': token } },
    ),
  getEvalToken: (id: number, token: string) =>
    apiClient.get<ApiResponse<{ id_kunjungan: number; kiosk_token: string }>>(
      `/api/wa/eval/${id}`, { headers: { 'X-Kiosk-Token': token } },
    ),
  inbox: () => apiClient.get<ApiResponse<WaInboxRow[]>>('/api/wa/inbox'),
}
