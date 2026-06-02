import apiClient from './client'
import type { ApiResponse } from '@/types/api'

export const pushApi = {
  getVapid: () => apiClient.get<ApiResponse<{ public_key: string }>>('/api/push/vapid'),
  subscribe: (subscription: PushSubscriptionJSON) =>
    apiClient.post<ApiResponse<null>>('/api/push/subscribe', { subscription }),
  unsubscribe: (endpoint: string) =>
    apiClient.post<ApiResponse<null>>('/api/push/unsubscribe', { endpoint }),
}
