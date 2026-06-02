import { useEffect, useRef } from 'react'
import { pushApi } from '@/api/push'

/**
 * Daftarkan browser ini ke Web Push (notifikasi desktop Windows) untuk admin.
 *
 * Alur (Tier-2): minta izin → ambil VAPID public key dari backend → subscribe
 * via service worker pushManager → kirim subscription ke /api/push/subscribe
 * (di-bind ke role user yang login). Service `notifier/` yang mengirim push-nya.
 *
 * Aman & non-blocking: no-op kalau SW/PushManager/Notification tidak tersedia
 * (mis. dev tanpa SW, browser lama) atau izin sudah 'denied'. Hanya jalan sekali
 * per mount. Pasang di TopNav supaya berlaku admin-wide.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function enablePush(): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return
  if (Notification.permission === 'denied') return

  let permission: NotificationPermission = Notification.permission
  if (permission === 'default') {
    permission = await Notification.requestPermission()
  }
  if (permission !== 'granted') return

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

export function usePushNotifications(enabled: boolean = true): void {
  const triedRef = useRef(false)
  useEffect(() => {
    if (!enabled || triedRef.current) return
    triedRef.current = true
    enablePush().catch((err) => console.warn('[push] gagal mengaktifkan notifikasi:', err))
  }, [enabled])
}

export { enablePush }
