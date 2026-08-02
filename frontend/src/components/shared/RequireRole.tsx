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
  /** Gerbang berjenjang: peran dengan level >= level ini diizinkan. */
  min?: UserRole
  /**
   * Daftar peran eksplisit. Dipakai ketika gerbang berjenjang TIDAK bisa
   * menyatakan maksudnya — mis. resepsionis selevel dengan petugas_pst,
   * verifikator, dan operator, sehingga min="resepsionis" akan ikut memberi
   * akses ke ketiganya. Cermin allowedRoles di Sidebar dan require_role_in()
   * di backend. Kalau diisi, daftar ini yang berlaku, bukan `min`.
   */
  allowedRoles?: UserRole[]
  children: React.ReactNode
}

/**
 * Route-level role gate. Prevents users without the required role from rendering
 * the protected page (which would just hit a backend 403 and show empty UI).
 * Backend remains authoritative — this is UX, not security.
 */
export function RequireRole({ min, allowedRoles, children }: Props) {
  const { user } = useAuth()
  const userLvl = user?.role ? ROLE_LEVEL[user.role] : 0
  // Gagal TERTUTUP bila pemanggil tidak memberi kriteria apa pun.
  const allowed = allowedRoles
    ? !!user?.role && allowedRoles.includes(user.role)
    : min
      ? userLvl >= ROLE_LEVEL[min]
      : false

  useEffect(() => {
    if (user && !allowed) {
      toast.error(
        allowedRoles
          ? `Halaman ini hanya untuk role: ${allowedRoles.join(', ')}.`
          : `Halaman ini hanya untuk role ${min} atau lebih tinggi.`
      )
    }
  }, [user, allowed, min, allowedRoles])

  if (!user) return null // AdminLayout handles unauth redirect
  if (!allowed) return <Navigate to="/admin" replace />
  return <>{children}</>
}
