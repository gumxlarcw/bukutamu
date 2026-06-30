import apiClient from './client'
import type { ApiResponse } from '@/types/api'

export type UserRole = 'superadmin' | 'admin' | 'operator' | 'resepsionis' | 'petugas_pst' | 'pimpinan' | 'verifikator'

export interface AuthUser {
  id: number
  username: string
  nama: string
  role?: UserRole
}

export const authApi = {
  check: () => apiClient.get<ApiResponse<AuthUser>>('/api/auth/check'),
  login: (username: string, password: string) =>
    apiClient.post<ApiResponse<AuthUser>>('/api/auth/login', { username, password }),
  logout: () => apiClient.post<ApiResponse<null>>('/api/auth/logout'),
}
