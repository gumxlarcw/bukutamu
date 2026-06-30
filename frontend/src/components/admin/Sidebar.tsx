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
  BadgeCheck,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
  // minRole = hierarchy gate (level-based). allowedRoles = explicit per-role whitelist
  // for gates that aren't hierarchy (e.g. PST/DTSEN only for petugas_pst, not resepsionis).
  minRole: UserRole
  allowedRoles?: UserRole[]
}

// Hierarchy: superadmin(3) > admin(2)=pimpinan(2) > operator/resepsionis/petugas_pst/verifikator(1)
const ROLE_LEVEL: Record<UserRole, number> = {
  operator: 1,
  resepsionis: 1,
  petugas_pst: 1,
  verifikator: 1,
  pimpinan: 2,
  admin: 2,
  superadmin: 3,
}

const PST_DTSEN_ROLES: UserRole[] = ['petugas_pst', 'operator', 'admin', 'superadmin', 'pimpinan']
const MUTATION_ENTRY_ROLES: UserRole[] = ['operator', 'admin', 'superadmin', 'petugas_pst', 'resepsionis']

const NAV_ITEMS: NavItem[] = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true, minRole: 'operator' },
  { to: '/admin/guests', label: 'Daftar Tamu', icon: Users, minRole: 'operator' },
  { to: '/admin/consultations', label: 'PST', icon: ClipboardList, minRole: 'operator', allowedRoles: PST_DTSEN_ROLES },
  { to: '/admin/dtsen', label: 'DTSEN', icon: Database, minRole: 'operator', allowedRoles: PST_DTSEN_ROLES },
  { to: '/admin/layanan-online', label: 'Layanan Online', icon: MessageSquare, minRole: 'operator', allowedRoles: PST_DTSEN_ROLES },
  { to: '/admin/verifikasi', label: 'Verifikasi', icon: BadgeCheck, minRole: 'operator', allowedRoles: ['verifikator', 'admin', 'superadmin'] },
  { to: '/admin/visits', label: 'Kunjungan', icon: FileText, minRole: 'operator' },
  { to: '/admin/manual-entry', label: 'Tambah Manual', icon: PlusCircle, minRole: 'operator', allowedRoles: MUTATION_ENTRY_ROLES },
  { to: '/admin/evaluations', label: 'Evaluasi', icon: Star, minRole: 'admin' },
  { to: '/admin/responden', label: 'Responden SKD', icon: CalendarDays, minRole: 'admin' },
  { to: '/admin/queue-stats', label: 'Analisis', icon: BarChart3, minRole: 'admin' },
  { to: '/admin/users', label: 'Users', icon: UserCog, minRole: 'superadmin' },
  { to: '/admin/audit', label: 'Audit', icon: Shield, minRole: 'admin' },
  { to: '/admin/tentang', label: 'Tentang', icon: Info, minRole: 'operator' },
]

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
  // Called when a nav link is tapped — used to auto-close the mobile drawer.
  onNavigate?: () => void
}

export function Sidebar({ collapsed, onToggle, onNavigate }: SidebarProps) {
  const { user, logout } = useAuth()
  const userRole = (user?.role ?? 'operator') as UserRole
  const userLevel = ROLE_LEVEL[userRole] ?? 1

  // Register this browser for Web Push while a user is logged in.
  usePushNotifications(!!user)

  const visibleItems = NAV_ITEMS.filter((item) => {
    // verifikator sees ONLY items that explicitly list 'verifikator' in allowedRoles
    if (userRole === 'verifikator') return item.allowedRoles?.includes('verifikator') ?? false
    if (item.allowedRoles && !item.allowedRoles.includes(userRole)) return false
    return userLevel >= ROLE_LEVEL[item.minRole]
  })

  return (
    <aside className="admin-sidebar">
      {/* Brand + collapse toggle */}
      <div className="admin-sidebar-brand">
        <img
          src="/logo-bps.png"
          alt="BPS"
          className="brand-logo"
          onError={(e) => { e.currentTarget.style.display = 'none' }}
        />
        <div className="brand-text min-w-0">
          <p className="text-sm font-bold leading-tight truncate text-[--admin-text]">Admin Buku Tamu 8200</p>
          <p className="text-[10px] leading-tight text-[--admin-text-muted]">BPS Provinsi Maluku Utara</p>
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="admin-side-toggle"
          title={collapsed ? 'Perluas menu' : 'Ciutkan menu'}
          aria-label={collapsed ? 'Perluas menu' : 'Ciutkan menu'}
        >
          {collapsed ? <PanelLeftOpen className="w-[18px] h-[18px]" /> : <PanelLeftClose className="w-[18px] h-[18px]" />}
        </button>
      </div>

      {/* Navigation */}
      <nav className="admin-sidebar-nav">
        {visibleItems.map((item) => {
          const Icon = item.icon
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={onNavigate}
              title={collapsed ? item.label : undefined}
              className={({ isActive }) => cn('admin-side-item', isActive && 'admin-side-active')}
            >
              <Icon className="w-[18px] h-[18px] shrink-0" />
              <span className="admin-side-label">{item.label}</span>
            </NavLink>
          )
        })}
      </nav>

      {/* Actions pinned at the bottom */}
      <div className="admin-sidebar-actions">
        <div className="admin-side-actionrow">
          <NotificationBell />
          {/* Secondary actions — hidden in the collapsed rail (would overflow), shown when expanded/mobile. */}
          <span className="admin-side-extra inline-flex items-center gap-1">
            <EnableNotificationsButton />
            <InstallPWAButton />
          </span>
        </div>
        {user && (
          <div className="admin-side-user admin-side-label">
            <span className="text-xs text-[--admin-text-muted] truncate block">{user.nama}</span>
          </div>
        )}
        <button type="button" onClick={() => logout()} className="admin-side-item" title="Keluar">
          <LogOut className="w-[18px] h-[18px] shrink-0" />
          <span className="admin-side-label">Keluar</span>
        </button>
      </div>
    </aside>
  )
}
