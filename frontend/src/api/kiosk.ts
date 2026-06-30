import apiClient from './client'
import type { ApiResponse } from '@/types/api'
import type { GuestFormData } from '@/types/guest'

export interface TicketData {
  id_kunjungan: number
  nomor_antrian: string | null
  nama: string
  jenis_layanan: string
  date_visit: string
}

export interface FaceData {
  id_user: number
  nama: string
  face_descriptor: number[]
}

export interface GuestListItem {
  id_user: number
  nama: string
  nama_instansi: string | null
}

interface VisitContext {
  jenis_layanan: string[]
  layanan_lainnya: string
  sarana: number[]
  sarana_lainnya: string
}

export const kioskApi = {
  getFaceData: () => apiClient.get<ApiResponse<FaceData[]>>('/api/kiosk/face-data'),
  getGuestList: () => apiClient.get<ApiResponse<GuestListItem[]>>('/api/kiosk/guest-list'),
  register: (data: GuestFormData & VisitContext & { foto: string; face_descriptor: number[]; biometric_consent: boolean; consent_timestamp: string }) =>
    apiClient.post<ApiResponse<{ id_kunjungan: number; id_user: number; nomor_antrian: string | null }>>('/api/kiosk/register', data),
  visit: (data: { id_user: number } & VisitContext) =>
    apiClient.post<ApiResponse<{ id_kunjungan: number; nomor_antrian: string | null }>>('/api/kiosk/visit', data),
  getTicket: (id: number) => apiClient.get<ApiResponse<TicketData>>(`/api/kiosk/ticket/${id}`),
  // Returns gaps + a short-lived (5 min) kiosk_token bound to this id_user.
  // The token must be passed to updateProfile via X-Kiosk-Token header.
  getProfileGaps: (id_user: number) =>
    apiClient.get<ApiResponse<{ gaps: string[]; kiosk_token: string }>>(`/api/kiosk/profile-gaps/${id_user}`),
  updateProfile: (id_user: number, data: Record<string, unknown>, kiosk_token: string) =>
    apiClient.post<ApiResponse<null>>(`/api/kiosk/profile-update/${id_user}`, data, {
      headers: { 'X-Kiosk-Token': kiosk_token },
    }),
  // WA online check-in (phone + face): find the WA visit, then promote it to the physical queue.
  // waLookup returns a short-lived kiosk_token bound to id_kunjungan; pass it to waPromote.
  // Server decides service/sarana from the WA registration — client sends NO service state.
  waLookup: (phone: string) =>
    apiClient.post<ApiResponse<{ nama: string; id_kunjungan: number; nomor_antrian: string | null; has_face: boolean; kiosk_token: string }>>('/api/kiosk/wa-lookup', { phone }),
  waPromote: (
    data: { id_kunjungan: number; foto: string; face_descriptor: number[]; biometric_consent: boolean; consent_timestamp: string },
    kiosk_token: string,
  ) =>
    apiClient.post<ApiResponse<{ id_kunjungan: number; nomor_antrian: string | null; mode: 'queue' | 'resepsionis' }>>('/api/kiosk/wa-promote', data, {
      headers: { 'X-Kiosk-Token': kiosk_token },
    }),
}
