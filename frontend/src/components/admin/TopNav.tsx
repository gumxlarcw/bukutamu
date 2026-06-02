import { NavLink } from 'react-router-dom'
import { useAuth } from '@/providers/AuthProvider'
import { cn } from '@/lib/utils'
import { InstallPWAButton } from '@/components/admin/InstallPWAButton'
import { NotificationBell } from '@/components/admin/NotificationBell'
import { EnableNotificationsButton } from '@/components/admin/EnableNotificationsButton'
import { usePushNotifications } from '@/hooks/usePushNotifications'
import type { UserRole } from '@/api/auth'
import {
  LayoutDashboard,
  Users,
  ClipboardList,
  Database,
  FileText,
  PlusCircle,
  Star,
  CalendarDays,
  Shield,
  BarChart3,
  UserCog,
  Info,
  MessageSquare,
  LogOut,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
  // minRole = hierarchy gate (level-based). minRole-only items default to inclusive
  // for higher tiers. Use `allowedRoles` untuk scoping per-role yang tidak ikut hierarchy.
  minRole: UserRole
  // Optional whitelist: kalau diisi, HANYA role di daftar ini yang bisa lihat item
  // (override minRole). Dipakai untuk gate yang bukan hierarchy — mis. PST/DTSEN
  // hanya untuk petugas_pst (bukan resepsionis sekalipun level sama).
  allowedRoles?: UserRole[]
}

// Hierarchy level: superadmin(3) > admin(2)=pimpinan(2) > operator(1)=resepsionis(1)=petugas_pst(1)
const ROLE_LEVEL: Record<UserRole, number> = {
  operator: 1,
  resepsionis: 1,
  petugas_pst: 1,
  pimpinan: 2,
  admin: 2,
  superadmin: 3,
}

// Roles yang boleh lihat menu antrian PST + DTSEN.
// - petugas_pst: operator harian (utama)
// - operator/admin/superadmin: bypass legacy (full access)
// - pimpinan: viewer (read-only, tombol mutasi disembunyikan di halaman terkait)
// - resepsionis: TIDAK termasuk (scope front-office saja)
const PST_DTSEN_ROLES: UserRole[] = ['petugas_pst', 'operator', 'admin', 'superadmin', 'pimpinan']

// Mutation-only entry. Pimpinan = viewer, jadi disembunyikan.
const MUTATION_ENTRY_ROLES: UserRole[] = ['operator', 'admin', 'superadmin', 'petugas_pst', 'resepsionis']

const NAV_ITEMS: NavItem[] = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true, minRole: 'operator' },
  { to: '/admin/guests', label: 'Daftar Tamu', icon: Users, minRole: 'operator' },
  { to: '/admin/consultations', label: 'PST', icon: ClipboardList, minRole: 'operator', allowedRoles: PST_DTSEN_ROLES },
  { to: '/admin/dtsen', label: 'DTSEN', icon: Database, minRole: 'operator', allowedRoles: PST_DTSEN_ROLES },
  { to: '/admin/layanan-online', label: 'Layanan Online', icon: MessageSquare, minRole: 'operator', allowedRoles: PST_DTSEN_ROLES },
  { to: '/admin/visits', label: 'Kunjungan', icon: FileText, minRole: 'operator' },
  { to: '/admin/manual-entry', label: 'Tambah Manual', icon: PlusCircle, minRole: 'operator', allowedRoles: MUTATION_ENTRY_ROLES },
  { to: '/admin/evaluations', label: 'Evaluasi', icon: Star, minRole: 'admin' },
  { to: '/admin/responden', label: 'Responden Tahunan', icon: CalendarDays, minRole: 'admin' },
  { to: '/admin/queue-stats', label: 'Analisis', icon: BarChart3, minRole: 'admin' },
  { to: '/admin/users', label: 'Users', icon: UserCog, minRole: 'superadmin' },
  { to: '/admin/audit', label: 'Audit', icon: Shield, minRole: 'admin' },
  { to: '/admin/tentang', label: 'Tentang', icon: Info, minRole: 'operator' },
]

export function TopNav() {
  const { user, logout } = useAuth()
  const userRole = (user?.role ?? 'operator') as UserRole
  const userLevel = ROLE_LEVEL[userRole] ?? 1

  // Daftarkan browser ini ke Web Push (notifikasi desktop) saat ada user login.
  // Admin-wide karena TopNav dirender di semua halaman admin.
  usePushNotifications(!!user)

  const visibleItems = NAV_ITEMS.filter(item => {
    if (item.allowedRoles && !item.allowedRoles.includes(userRole)) return false
    return userLevel >= ROLE_LEVEL[item.minRole]
  })

  return (
    <header className="admin-topnav">
      <div className="admin-topnav-inner">
        {/* Logo + brand */}
        <div className="flex items-center gap-3 shrink-0">
          <img
            src="/logo-bps.png"
            alt="BPS"
            className="h-8 w-auto object-contain"
            onError={(e) => { e.currentTarget.style.display = 'none' }}
          />
          <div className="hidden sm:block">
            <p className="text-sm font-bold leading-tight text-[--admin-text]">Admin Buku Tamu 8200</p>
            <p className="text-[10px] leading-tight text-[--admin-text-muted]">BPS Provinsi Maluku Utara</p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex items-center gap-1">
          {visibleItems.map((item) => {
            const Icon = item.icon
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'admin-nav-item',
                    isActive && 'admin-nav-active'
                  )
                }
              >
                <Icon className="w-4 h-4" />
                <span className="hidden md:inline">{item.label}</span>
              </NavLink>
            )
          })}
        </nav>

        {/* Actions */}
        <div className="flex items-center gap-3 shrink-0">
          <NotificationBell />
          <EnableNotificationsButton />
          <InstallPWAButton />
          {user && (
            <span className="hidden lg:inline text-xs text-[--admin-text-muted]">
              {user.nama}
            </span>
          )}
          <button
            onClick={logout}
            className="admin-nav-item !gap-1.5 text-[--admin-text-muted]"
          >
            <LogOut className="w-4 h-4" />
            <span className="hidden sm:inline text-xs">Keluar</span>
          </button>
        </div>
      </div>
    </header>
  )
}
