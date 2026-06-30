import { Navigate } from 'react-router-dom'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { useAuth } from '@/providers/AuthProvider'
import type { UserRole } from '@/api/auth'

// Mirrors Api_base::require_role hierarchy. Keep in sync with backend.
// pimpinan = viewer tier (level 2): boleh lihat halaman read-only setara admin
// (audit, evaluasi) tapi TIDAK punya bypass untuk mutasi layanan — gate
// require_layanan_role() di backend tetap menolak finalisasi visit untuk pimpinan.
const ROLE_LEVEL: Record<UserRole, number> = {
  operator: 1,
  resepsionis: 1,
  petugas_pst: 1,
  verifikator: 1,
  pimpinan: 2,
  admin: 2,
  superadmin: 3,
}

interface Props {
  min: UserRole
  children: React.ReactNode
}

/**
 * Route-level role gate. Prevents users without the required role from rendering
 * the protected page (which would just hit a backend 403 and show empty UI).
 * Backend remains authoritative — this is UX, not security.
 */
export function RequireRole({ min, children }: Props) {
  const { user } = useAuth()
  const userLvl = user?.role ? ROLE_LEVEL[user.role] : 0
  const minLvl = ROLE_LEVEL[min]
  const allowed = userLvl >= minLvl

  useEffect(() => {
    if (user && !allowed) {
      toast.error(`Halaman ini hanya untuk role ${min} atau lebih tinggi.`)
    }
  }, [user, allowed, min])

  if (!user) return null // AdminLayout handles unauth redirect
  if (!allowed) return <Navigate to="/admin" replace />
  return <>{children}</>
}
