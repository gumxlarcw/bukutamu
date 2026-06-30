import apiClient from './client'
import type { ApiResponse, PaginatedResponse } from '@/types/api'

export interface RespondenRow {
  id_user: number
  nama: string
  email?: string | null
  notel?: string | null
  jeniskelamin?: string | null
  umur?: string | number | null
  disabilitas?: string | number | null
  jenis_disabilitas?: string | number | null
  pendidikan?: string | number | null
  pekerjaan?: string | number | null
  pekerjaan_lainnya?: string | null
  kategori_instansi?: string | number | null
  kategori_lainnya?: string | null
  nama_instansi: string
  pemanfaatan?: string | number | null
  pemanfaatan_lainnya?: string | null
  jenis_layanan: string | null
  layanan_lainnya: string | null
  sarana: string | null
  sarana_lainnya: string | null
  max_visit: string
  total_kunjungan: number
}

export interface RespondenSummary {
  total_users: number
  skd_eligible: number
}

export interface RespondenParams {
  tahun: string
  q?: string
  page?: number
  limit?: number
  triwulan?: string
  skd?: string
}

// Backend response also carries a `summary` field alongside the paginated
// envelope — extend PaginatedResponse to surface it as typed metadata.
export type RespondenListResponse = PaginatedResponse<RespondenRow> & {
  summary: RespondenSummary
}

// One row per EVALUATED visit (SKD survey response) for the CSV export.
export interface RespondenVisitRow {
  id_kunjungan: number | string
  id_user: number | string
  date_visit: string
  nama: string
  email?: string | null
  notel?: string | null
  jeniskelamin?: string | null
  umur?: string | number | null
  disabilitas?: string | number | null
  jenis_disabilitas?: string | number | null
  pendidikan?: string | number | null
  pekerjaan?: string | number | null
  pekerjaan_lainnya?: string | null
  kategori_instansi?: string | number | null
  kategori_lainnya?: string | null
  nama_instansi: string | null
  pemanfaatan?: string | number | null
  pemanfaatan_lainnya?: string | null
  jenis_layanan: string | null
  layanan_lainnya: string | null
  sarana: string | null
  sarana_lainnya: string | null
  rating_pengunjung?: number | string | null
  indikator: Record<string, number | string>
}

export interface RespondenExportData {
  visits: RespondenVisitRow[]
  indikator_labels: Record<string, string>
}

export const respondenApi = {
  list: (params: RespondenParams) =>
    apiClient.get<RespondenListResponse>('/api/responden', { params }),
  // Per-evaluated-visit rows (one survey response = one row). One person with 2 evaluated
  // visits at different times = 2 rows.
  exportVisits: (params: { tahun: string; triwulan?: string }) =>
    apiClient.get<ApiResponse<RespondenExportData>>('/api/responden/export', { params }),
}
