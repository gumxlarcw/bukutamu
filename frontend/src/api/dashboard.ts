import apiClient from './client'
import type { ApiResponse } from '@/types/api'
import type { DashboardStats, CalendarEvent } from '@/types/visit'

export const dashboardApi = {
  stats: (params?: { date_from?: string; date_to?: string }) =>
    apiClient.get<ApiResponse<DashboardStats>>('/api/dashboard/stats', { params }),
  events: (params?: { date_from?: string; date_to?: string }) =>
    apiClient.get<ApiResponse<CalendarEvent[]>>('/api/dashboard/events', { params }),
}
