import apiClient from './client'
import type { ApiResponse } from '@/types/api'
import type { WaSessionPrefill, WaIntakePayload, WaInboxRow, WaQrState, WaMessage } from '@/types/wa'

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
  getQrState: () => apiClient.get<ApiResponse<WaQrState>>('/api/wa/qr-state'),
  disconnect: () => apiClient.post<ApiResponse<null>>('/api/wa/disconnect'),
  // Link with phone number: minta pairing code utk sebuah nomor (phone kosong = batal → kembali ke QR).
  requestPair: (phone: string) =>
    apiClient.post<ApiResponse<{ pair_phone: string | null }>>('/api/wa/pair', { phone }),

  // Live chat (web petugas ↔ WhatsApp)
  getMessages: (phone: string, after = 0) =>
    apiClient.get<ApiResponse<WaMessage[]>>('/api/wa/messages', { params: { phone, after } }),
  sendText: (phone: string, body: string) =>
    apiClient.post<ApiResponse<WaMessage>>('/api/wa/messages', { phone, body }),
  uploadFile: (phone: string, file: File, caption?: string, onProgress?: (pct: number) => void) => {
    const fd = new FormData()
    fd.append('phone', phone)
    fd.append('file', file)
    if (caption) fd.append('caption', caption)
    return apiClient.post<ApiResponse<WaMessage>>('/api/wa/messages/upload', fd, {
      onUploadProgress: onProgress
        ? (e) => onProgress(e.total ? Math.round((e.loaded * 100) / e.total) : 0)
        : undefined,
    })
  },
  // Antri-kan backfill histori chat (connector fetchMessages → wa_messages, dedup).
  requestBackfill: (phone: string) =>
    apiClient.post<ApiResponse<{ queued: boolean }>>('/api/wa/messages/backfill', { phone }),

  // Hapus sesi PENDING (admin only). Sesi yang sudah jadi kunjungan → visitsApi.delete.
  deleteSession: (sessionId: number) =>
    apiClient.delete<ApiResponse<null>>(`/api/wa/sessions/${sessionId}`),

  // Tandai visit 'diproses' saat petugas membuka popup Proses (antri/dipanggil → diproses).
  markProses: (idKunjungan: number) =>
    apiClient.post<ApiResponse<{ status: string }>>(`/api/wa/visits/${idKunjungan}/proses`),
}
