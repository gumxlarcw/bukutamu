import axios from 'axios'

/**
 * Human-readable message from an unknown error. For an axios error it returns the
 * backend envelope's `message` (shape `{ success, data, message }`); otherwise the
 * fallback. Replaces the scattered `(e as any).response?.data?.message` casts and
 * their per-line eslint-disable comments (audit 2026-07-12 #40/#46).
 */
export function getApiErrorMessage(e: unknown, fallback = 'Terjadi kesalahan'): string {
  if (axios.isAxiosError(e)) {
    const msg = (e.response?.data as { message?: string } | undefined)?.message
    if (typeof msg === 'string' && msg) return msg
  }
  return fallback
}
