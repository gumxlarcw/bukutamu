import { NavLink } from 'react-router-dom'
import { useAuth } from '@/providers/AuthProvider'
import { ThemeToggle } from '@/components/shared/ThemeToggle'
import { cn } from '@/lib/utils'
import type { UserRole } from '@/api/auth'
import {
  LayoutDashboard,
  Users,
  ClipboardList,
  Database,
  FileText,
  PlusCircle,
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
  // Whitelist role yang boleh lihat menu. Kalau undefined = semua role auth.
  allowedRoles?: UserRole[]
}

// Cermin TopNav: PST/DTSEN hanya untuk petugas PST + admin tier + pimpinan (viewer).
// Resepsionis TIDAK termasuk (scope front-office saja).
const PST_DTSEN_ROLES: UserRole[] = ['petugas_pst', 'operator', 'admin', 'superadmin', 'pimpinan']
// Tambah kunjungan = mutation entry. Pimpinan viewer-only, jadi disembunyikan.
const MUTATION_ENTRY_ROLES: UserRole[] = ['operator', 'admin', 'superadmin', 'petugas_pst', 'resepsionis']

const NAV_ITEMS: NavItem[] = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/admin/guests', label: 'Daftar Tamu', icon: Users },
  { to: '/admin/consultations', label: 'Antrian PST', icon: ClipboardList, allowedRoles: PST_DTSEN_ROLES },
  { to: '/admin/dtsen', label: 'Antrian DTSEN', icon: Database, allowedRoles: PST_DTSEN_ROLES },
  { to: '/admin/visits', label: 'Daftar Kunjungan', icon: FileText },
  { to: '/admin/layanan-online', label: 'Layanan Online', icon: MessageSquare, allowedRoles: PST_DTSEN_ROLES },
  { to: '/admin/manual-entry', label: 'Tambah Kunjungan', icon: PlusCircle, allowedRoles: MUTATION_ENTRY_ROLES },
  { to: '/admin/tentang', label: 'Tentang', icon: Info },
]

export function Sidebar() {
  const { user, logout } = useAuth()
  const userRole = (user?.role ?? 'operator') as UserRole
  const visibleItems = NAV_ITEMS.filter(item =>
    !item.allowedRoles || item.allowedRoles.includes(userRole)
  )

  return (
    <aside
      className="flex flex-col w-64 min-h-screen shrink-0"
      style={{
        background: '#111113',
        borderRight: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      {/* Logo + Brand */}
      <div className="px-6 pt-6 pb-5">
        <div className="flex items-center gap-3">
          <img
            src="/logo-bps.png"
            alt="BPS"
            className="h-9 w-auto object-contain"
            onError={(e) => { e.currentTarget.style.display = 'none' }}
          />
          <div className="min-w-0">
            <h1 className="text-sm font-bold text-white leading-tight truncate">Admin Buku Tamu 8200</h1>
            <p className="text-[11px] text-white/40 leading-tight truncate">BPS Prov. Maluku Utara</p>
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="mx-4 h-px bg-white/8 mb-2" />

      {/* Navigation */}
      <nav className="flex-1 px-3 space-y-0.5">
        {visibleItems.map((item) => {
          const Icon = item.icon
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 px-4 py-2.5 rounded-xl text-[13px] font-medium transition-all',
                  isActive
                    ? 'bg-orange-500/15 text-orange-400'
                    : 'text-white/50 hover:text-white/80 hover:bg-white/5'
                )
              }
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span>{item.label}</span>
            </NavLink>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="px-4 py-4 space-y-3">
        <div className="h-px bg-white/8" />
        <div className="flex items-center justify-between">
          <ThemeToggle />
          <button
            onClick={logout}
            className="flex items-center gap-1.5 text-xs text-white/40 hover:text-red-400 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            Logout
          </button>
        </div>
      </div>
    </aside>
  )
}
