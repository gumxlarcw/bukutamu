import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '@/providers/AuthProvider'
import { TopNav } from '@/components/admin/TopNav'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'

export function AdminLayout() {
  const { user, isLoading } = useAuth()

  if (isLoading) return <LoadingSpinner className="min-h-screen" />
  if (!user) return <Navigate to="/login" replace />

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;0,9..40,800;1,9..40,400&display=swap');

        :root {
          --admin-bg: #f7f5f0;
          --admin-surface: #ffffff;
          --admin-text: #2a2016;
          --admin-text-secondary: #5c5347;
          --admin-text-muted: #7a7068;
          --admin-border: rgba(42, 32, 22, 0.08);
          --admin-border-strong: rgba(42, 32, 22, 0.14);
          --admin-primary: #c4570a;
          --admin-primary-light: #fef3ec;
          --admin-secondary: #0c7075;
          --admin-secondary-light: #ecf7f7;
          --admin-shadow: 0 1px 3px rgba(42, 32, 22, 0.05), 0 1px 2px rgba(42, 32, 22, 0.03);
          --admin-shadow-lg: 0 4px 20px rgba(42, 32, 22, 0.07), 0 2px 6px rgba(42, 32, 22, 0.04);
          --admin-radius: 14px;
        }

        /* ── Shell ── */
        .admin-shell {
          font-family: 'DM Sans', system-ui, sans-serif;
          background: var(--admin-bg);
          color: var(--admin-text);
          min-height: 100vh;
          position: relative;
        }
        /* Subtle batik pattern — same as login page */
        .admin-shell::before {
          content: '';
          position: fixed;
          inset: 0;
          pointer-events: none;
          opacity: 0.025;
          background-image:
            repeating-linear-gradient(45deg, transparent, transparent 20px, #2a2016 20px, #2a2016 21px),
            repeating-linear-gradient(-45deg, transparent, transparent 20px, #2a2016 20px, #2a2016 21px);
          z-index: 0;
        }

        /* ── Top Navigation ── */
        .admin-topnav {
          position: sticky;
          top: 0;
          z-index: 40;
          background: rgba(255, 255, 255, 0.88);
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          border-bottom: 1px solid var(--admin-border);
        }
        .admin-topnav-inner {
          width: 100%;
          padding: 8px 32px;
          min-height: 56px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .admin-nav-item {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 7px 13px;
          border-radius: 10px;
          font-size: 13px;
          font-weight: 500;
          color: var(--admin-text-muted);
          transition: all 0.2s ease;
          white-space: nowrap;
          text-decoration: none;
        }
        .admin-nav-item:hover {
          color: var(--admin-text);
          background: rgba(42, 32, 22, 0.05);
        }
        .admin-nav-active {
          color: var(--admin-primary) !important;
          background: var(--admin-primary-light) !important;
          font-weight: 600;
        }
        /* Tighter gutters on small screens; the nav wraps so all menu items stay visible. */
        @media (max-width: 640px) {
          .admin-topnav-inner {
            padding: 8px 12px;
            gap: 8px;
          }
          .admin-content {
            padding: 20px 14px;
          }
        }

        /* ── Content area ── */
        .admin-content {
          position: relative;
          z-index: 1;
          width: 100%;
          padding: 28px 32px;
        }

        /* ── Shared card style ── */
        .admin-card {
          background: var(--admin-surface);
          border: 1px solid var(--admin-border);
          border-radius: var(--admin-radius);
          box-shadow: var(--admin-shadow);
          transition: box-shadow 0.2s ease;
        }
        .admin-card:hover {
          box-shadow: var(--admin-shadow-lg);
        }

        /* ── Page entrance ── */
        .admin-enter {
          opacity: 0;
          transform: translateY(14px);
          animation: adminFadeIn 0.55s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        @keyframes adminFadeIn {
          to { opacity: 1; transform: translateY(0); }
        }

        /* ── Headings ── */
        .admin-h1 {
          font-size: 22px;
          font-weight: 700;
          color: var(--admin-text);
          letter-spacing: -0.4px;
          line-height: 1.2;
        }
        .admin-subtitle {
          font-size: 13px;
          color: var(--admin-text-muted);
          margin-top: 3px;
        }

        /* ── Global form inputs ── */
        .admin-shell input[type="text"],
        .admin-shell input[type="email"],
        .admin-shell input[type="tel"],
        .admin-shell input[type="password"],
        .admin-shell input[type="date"],
        .admin-shell input[type="search"],
        .admin-shell select,
        .admin-shell textarea {
          font-family: 'DM Sans', system-ui, sans-serif;
          border-radius: 10px;
          border: 1.5px solid var(--admin-border-strong);
          background: rgba(255,255,255,0.7);
          color: var(--admin-text);
          transition: all 0.2s ease;
        }
        .admin-shell input:focus,
        .admin-shell select:focus,
        .admin-shell textarea:focus {
          border-color: var(--admin-primary);
          background: var(--admin-surface);
          box-shadow: 0 0 0 3px rgba(196, 87, 10, 0.08);
          outline: none;
        }
        .admin-shell input::placeholder,
        .admin-shell textarea::placeholder {
          color: var(--admin-text-muted);
        }

        /* ── Global table styling ── */
        .admin-shell table {
          font-family: 'DM Sans', system-ui, sans-serif;
        }
        .admin-shell th {
          font-weight: 600;
          letter-spacing: 0.03em;
        }
        .admin-shell tr {
          transition: background 0.15s ease;
        }

        /* ── Buttons ── */
        .admin-btn-primary {
          background: var(--admin-primary);
          color: #fff;
          border: none;
          border-radius: 10px;
          padding: 10px 20px;
          font-size: 13px;
          font-weight: 600;
          font-family: inherit;
          cursor: pointer;
          transition: all 0.2s ease;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .admin-btn-primary:hover { background: #b04d09; }
        .admin-btn-primary:active { transform: scale(0.98); }

        .admin-btn-secondary {
          background: var(--admin-secondary);
          color: #fff;
          border: none;
          border-radius: 10px;
          padding: 10px 20px;
          font-size: 13px;
          font-weight: 600;
          font-family: inherit;
          cursor: pointer;
          transition: all 0.2s ease;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .admin-btn-secondary:hover { background: #0a5f63; }

        .admin-btn-outline {
          background: transparent;
          color: var(--admin-text-secondary);
          border: 1.5px solid var(--admin-border-strong);
          border-radius: 10px;
          padding: 9px 18px;
          font-size: 13px;
          font-weight: 500;
          font-family: inherit;
          cursor: pointer;
          transition: all 0.2s ease;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .admin-btn-outline:hover {
          background: rgba(42, 32, 22, 0.04);
          border-color: rgba(42, 32, 22, 0.2);
        }

        /* ── Dialogs ── */
        .admin-shell [role="dialog"] {
          border-radius: var(--admin-radius) !important;
          border: 1px solid var(--admin-border);
          box-shadow: var(--admin-shadow-lg), 0 0 0 1px rgba(42,32,22,0.04);
        }

        /* ── Badges / Chips ── */
        .admin-shell .rounded-full {
          font-family: 'DM Sans', system-ui, sans-serif;
        }

        /* ── Override kiosk VisitorForm for admin context ── */
        .admin-form-wrap label {
          color: var(--admin-text) !important;
          font-size: 13px !important;
          font-weight: 500 !important;
        }
        .admin-form-wrap input,
        .admin-form-wrap select {
          background: rgba(255,255,255,0.7) !important;
          border: 1.5px solid var(--admin-border-strong) !important;
          color: var(--admin-text) !important;
          border-radius: 10px !important;
        }
        .admin-form-wrap input::placeholder {
          color: var(--admin-text-muted) !important;
        }
        .admin-form-wrap input:focus,
        .admin-form-wrap select:focus {
          border-color: var(--admin-primary) !important;
          background: var(--admin-surface) !important;
          box-shadow: 0 0 0 3px rgba(196, 87, 10, 0.08) !important;
          outline: none;
        }
        .admin-form-wrap button[type="button"] {
          background: rgba(255,255,255,0.7) !important;
          border: 1.5px solid var(--admin-border-strong) !important;
          color: var(--admin-text-secondary) !important;
          border-radius: 10px !important;
        }
        .admin-form-wrap .border-orange-400,
        .admin-form-wrap .bg-orange-500 {
          border-color: var(--admin-primary) !important;
          background: var(--admin-primary) !important;
          color: #fff !important;
        }

        /* ── Scrollbar ── */
        .admin-shell ::-webkit-scrollbar { width: 6px; height: 6px; }
        .admin-shell ::-webkit-scrollbar-track { background: transparent; }
        .admin-shell ::-webkit-scrollbar-thumb { background: rgba(42,32,22,0.15); border-radius: 3px; }
        .admin-shell ::-webkit-scrollbar-thumb:hover { background: rgba(42,32,22,0.25); }
      `}</style>

      <div className="admin-shell">
        <TopNav />
        <div className="admin-content">
          <div className="admin-enter">
            <Outlet />
          </div>
        </div>
      </div>
    </>
  )
}
