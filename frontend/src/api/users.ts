import apiClient from './client'
import type { ApiResponse } from '@/types/api'
import type { UserRole } from './auth'

export interface AdminUser {
  id: number
  username: string
  nama: string
  role: Exclude<UserRole, 'resepsionis' | 'petugas_pst'>
  notel: string | null
  // CI3 mysqli mengembalikan angka sebagai STRING ("0"/"1"). Tipe `number` di sini
  // adalah kebohongan yang membuat tsc TIDAK bisa menangkap `!u.active` — dan `!"0"`
  // bernilai false, sehingga badge "Nonaktif" tidak pernah muncul dan edit berikutnya
  // diam-diam mengaktifkan lagi akun yang baru dinonaktifkan.
  // Selalu bandingkan lewat Number(). Lihat docs/AUDIT_2026-08-01.md temuan #5.
  active: number | string
  last_login: string | null
  created_at: string
}

export interface CreateUserForm {
  username: string
  password: string
  nama: string
  role: string
  notel?: string
}

export interface UpdateUserForm {
  nama?: string
  role?: string
  password?: string
  active?: boolean
  notel?: string | null
}

export interface ChangePasswordForm {
  old_password: string
  new_password: string
}

export const usersApi = {
  list: () =>
    apiClient.get<ApiResponse<AdminUser[]>>('/api/users'),
  create: (form: CreateUserForm) =>
    apiClient.post<ApiResponse<null>>('/api/users', form),
  update: (id: number, form: UpdateUserForm) =>
    apiClient.put<ApiResponse<null>>(`/api/users/${id}`, form),
  delete: (id: number) =>
    apiClient.delete<ApiResponse<null>>(`/api/users/${id}`),
  changePassword: (form: ChangePasswordForm) =>
    apiClient.post<ApiResponse<null>>('/api/users/change-password', form),
}
