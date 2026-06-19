import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from '@/providers/AuthProvider'
import { ThemeProvider } from '@/providers/ThemeProvider'
import { QueryProvider } from '@/providers/QueryProvider'
import { KioskLayout } from '@/layouts/KioskLayout'
import { AdminLayout } from '@/layouts/AdminLayout'
import { lazy, Suspense } from 'react'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { ErrorBoundary } from '@/components/shared/ErrorBoundary'
import { RequireRole } from '@/components/shared/RequireRole'

// Retry dynamic imports — handles stale chunks after deployments
function lazyRetry(factory: () => Promise<{ default: React.ComponentType }>) {
  return lazy(() =>
    factory().catch(() => {
      // Force reload from server on chunk load failure
      const key = 'lazy-retry-reload'
      const last = sessionStorage.getItem(key)
      const now = Date.now()
      if (!last || now - Number(last) > 10000) {
        sessionStorage.setItem(key, String(now))
        window.location.reload()
      }
      return factory()
    }),
  )
}

const WelcomePage = lazyRetry(() => import('@/pages/kiosk/WelcomePage'))
const StatusSelectPage = lazyRetry(() => import('@/pages/kiosk/StatusSelectPage'))
const ServiceSelectPage = lazyRetry(() => import('@/pages/kiosk/ServiceSelectPage'))
const VisitorFormPage = lazyRetry(() => import('@/pages/kiosk/VisitorFormPage'))
const FaceCapturePage = lazyRetry(() => import('@/pages/kiosk/FaceCapturePage'))
const FaceRecognizePage = lazyRetry(() => import('@/pages/kiosk/FaceRecognizePage'))
const WaCheckInPage = lazyRetry(() => import('@/pages/kiosk/WaCheckInPage'))
const TicketPage = lazyRetry(() => import('@/pages/kiosk/TicketPage'))
const EvaluationStandbyPage = lazyRetry(() => import('@/pages/kiosk/EvaluationStandbyPage'))
const EvaluationPage = lazyRetry(() => import('@/pages/kiosk/EvaluationPage'))
const LayananOnlinePage = lazyRetry(() => import('@/pages/wa/LayananOnlinePage'))
const EvaluasiOnlinePage = lazyRetry(() => import('@/pages/wa/EvaluasiOnlinePage'))
const LoginPage = lazyRetry(() => import('@/pages/admin/LoginPage'))
const DashboardPage = lazyRetry(() => import('@/pages/admin/DashboardPage'))
const GuestListPage = lazyRetry(() => import('@/pages/admin/GuestListPage'))
const GuestAddPage = lazyRetry(() => import('@/pages/admin/GuestAddPage'))
const ConsultationQueuePage = lazyRetry(() => import('@/pages/admin/ConsultationQueuePage'))
const ConsultationFormPage = lazyRetry(() => import('@/pages/admin/ConsultationFormPage'))
const LayananOnlineInboxPage = lazyRetry(() => import('@/pages/admin/LayananOnlineInboxPage'))
const DtsenQueuePage = lazyRetry(() => import('@/pages/admin/DtsenQueuePage'))
const DtsenFormPage = lazyRetry(() => import('@/pages/admin/DtsenFormPage'))
const VisitLogPage = lazyRetry(() => import('@/pages/admin/VisitLogPage'))
const ManualEntryPage = lazyRetry(() => import('@/pages/admin/ManualEntryPage'))
const EvaluationSummaryPage = lazyRetry(() => import('@/pages/admin/EvaluationSummaryPage'))
const RespondenTahunanPage = lazyRetry(() => import('@/pages/admin/RespondenTahunanPage'))
const AuditLogPage = lazyRetry(() => import('@/pages/admin/AuditLogPage'))
const UserManagementPage = lazyRetry(() => import('@/pages/admin/UserManagementPage'))
const GuestImportPage = lazyRetry(() => import('@/pages/admin/GuestImportPage'))
const QueueStatsPage = lazyRetry(() => import('@/pages/admin/QueueStatsPage'))
const AboutPage = lazyRetry(() => import('@/pages/admin/AboutPage'))
const LandingPage = lazyRetry(() => import('@/pages/LandingPage'))
const NotFoundPage = lazyRetry(() => import('@/pages/NotFoundPage'))

function App() {
  return (
    <ErrorBoundary>
    <BrowserRouter>
      <QueryProvider>
        <ThemeProvider>
          <AuthProvider>
            <Suspense fallback={<LoadingSpinner className="min-h-screen" />}>
              <Routes>
                <Route element={<KioskLayout />}>
                  <Route path="/kiosk" element={<WelcomePage />} />
                  <Route path="/kiosk/status" element={<StatusSelectPage />} />
                  <Route path="/kiosk/service" element={<ServiceSelectPage />} />
                  <Route path="/kiosk/form" element={<VisitorFormPage />} />
                  <Route path="/kiosk/capture" element={<FaceCapturePage />} />
                  <Route path="/kiosk/recognize" element={<FaceRecognizePage />} />
                  <Route path="/kiosk/wa-checkin" element={<WaCheckInPage />} />
                  <Route path="/kiosk/ticket/:id" element={<TicketPage />} />
                </Route>
                <Route path="/kiosk/evaluasi" element={<EvaluationStandbyPage />} />
                <Route path="/kiosk/evaluasi/:id" element={<EvaluationPage />} />
                <Route path="/layanan-online/:sessionId" element={<LayananOnlinePage />} />
                <Route path="/evaluasi/:id" element={<EvaluasiOnlinePage />} />
                <Route path="/login" element={<LoginPage />} />
                <Route element={<AdminLayout />}>
                  <Route path="/admin" element={<DashboardPage />} />
                  <Route path="/admin/guests" element={<GuestListPage />} />
                  <Route path="/admin/guests/add" element={<GuestAddPage />} />
                  <Route path="/admin/guests/import" element={<GuestImportPage />} />
                  <Route path="/admin/consultations" element={<ConsultationQueuePage />} />
                  <Route path="/admin/consultations/:id/form" element={<ConsultationFormPage />} />
                  <Route path="/admin/layanan-online" element={<LayananOnlineInboxPage />} />
                  <Route path="/admin/dtsen" element={<DtsenQueuePage />} />
                  <Route path="/admin/dtsen/:id/form" element={<DtsenFormPage />} />
                  <Route path="/admin/visits" element={<VisitLogPage />} />
                  <Route path="/admin/manual-entry" element={<ManualEntryPage />} />
                  <Route path="/admin/evaluations" element={<EvaluationSummaryPage />} />
                  <Route path="/admin/responden" element={<RespondenTahunanPage />} />
                  <Route path="/admin/audit" element={<RequireRole min="admin"><AuditLogPage /></RequireRole>} />
                  <Route path="/admin/users" element={<RequireRole min="superadmin"><UserManagementPage /></RequireRole>} />
                  <Route path="/admin/queue-stats" element={<QueueStatsPage />} />
                  <Route path="/admin/tentang" element={<AboutPage />} />
                </Route>
                <Route path="/" element={<LandingPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </Suspense>
          </AuthProvider>
        </ThemeProvider>
      </QueryProvider>
    </BrowserRouter>
    </ErrorBoundary>
  )
}

export default App
