import { useEffect, useRef } from 'react'
import { pushApi } from '@/api/push'

/**
 * Web Push (notifikasi desktop Windows) untuk admin.
 *
 * Penting: prompt izin (`Notification.requestPermission`) HANYA dipanggil dari
 * gesture user (tombol "Aktifkan Notifikasi" → enablePush). Browser memblokir
 * permintaan izin tanpa interaksi, jadi memanggilnya saat mount tidak memunculkan
 * prompt. Hook ini saat mount hanya subscribe DIAM-DIAM kalau izin sudah granted.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

// Subscribe ke pushManager + kirim ke backend. Asumsi izin sudah 'granted'.
async function doSubscribe(): Promise<void> {
  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    const res = await pushApi.getVapid()
    const key = res.data.data?.public_key
    if (!key) return
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      // Cast: lib.dom mengetik applicationServerKey sbg BufferSource; Uint8Array
      // generic (ArrayBufferLike) tidak otomatis cocok di TS terbaru. Runtime aman.
      applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
    })
  }
  // Idempoten di backend (upsert by endpoint) — refresh role/last_seen.
  await pushApi.subscribe(sub.toJSON())
}

/**
 * Dipanggil dari gesture user (tombol). Minta izin lalu subscribe.
 * Return permission akhir supaya pemanggil bisa update UI.
 */
export async function enablePush(): Promise<NotificationPermission> {
  if (!pushSupported()) return 'denied'
  let permission: NotificationPermission = Notification.permission
  if (permission === 'default') {
    permission = await Notification.requestPermission()
  }
  if (permission === 'granted') {
    await doSubscribe()
  }
  return permission
}

/**
 * Pasang di TopNav. Saat mount, kalau izin SUDAH granted → subscribe diam-diam
 * (mis. user yang sudah pernah mengaktifkan). TIDAK memprompt di sini.
 */
export function usePushNotifications(enabled: boolean = true): void {
  const triedRef = useRef(false)
  useEffect(() => {
    if (!enabled || triedRef.current) return
    triedRef.current = true
    if (!pushSupported() || Notification.permission !== 'granted') return
    doSubscribe().catch((err) => console.warn('[push] subscribe gagal:', err))
  }, [enabled])
}
