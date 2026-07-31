import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import { dashboardApi } from '@/api/dashboard'
import { StatsCard } from '@/components/admin/StatsCard'
import { TrendChart } from '@/components/admin/TrendChart'
import { ServiceBars } from '@/components/admin/ServiceBars'
import { MiniStat } from '@/components/admin/MiniStat'
import { agregatTren, agregatLayanan, satuanTren } from '@/lib/dashboard-aggregate'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Users, User, CheckCircle, BarChart3 } from 'lucide-react'

function DashboardSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-[1.6fr_1fr] gap-5">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [filterParams, setFilterParams] = useState<{ date_from?: string; date_to?: string }>({})

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['dashboard-stats', filterParams],
    queryFn: () => dashboardApi.stats(filterParams).then(r => r.data.data),
  })

  const { data: events, isLoading: eventsLoading, isError: eventsError } = useQuery({
    queryKey: ['dashboard-events', filterParams],
    queryFn: () => dashboardApi.events(filterParams).then(r => r.data.data),
  })

  const tren = useMemo(() => agregatTren(events ?? []), [events])
  const satuan = useMemo(() => satuanTren(events ?? []), [events])
  const layanan = useMemo(() => agregatLayanan(events ?? []), [events])

  // Kalender harus terbuka di bulan awal rentang filter, bukan selalu bulan
  // berjalan — dan `key` hanya bergantung pada filterParams (bukan events/
  // eventsLoading) supaya paging manual pengguna tidak dipaksa reset oleh
  // re-render yang tak terkait filter.
  const calendarInitialDate = filterParams.date_from ?? filterParams.date_to ?? undefined
  const calendarKey = `${filterParams.date_from ?? ''}_${filterParams.date_to ?? ''}`

  const handleFilter = () => {
    setFilterParams({
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
    })
  }

  const handleReset = () => {
    setDateFrom('')
    setDateTo('')
    setFilterParams({})
  }

  const sorotan = stats
    ? [
        { label: 'Total Kunjungan', value: stats.total_kunjungan, icon: <Users className="w-5 h-5" /> },
        { label: 'Tamu Unik', value: stats.tamu_unik, icon: <User className="w-5 h-5" /> },
        { label: 'Tingkat Selesai', value: `${stats.tingkat_selesai}%`, icon: <CheckCircle className="w-5 h-5" /> },
        { label: 'Rata-rata/Hari', value: stats.rata_rata_per_hari, icon: <BarChart3 className="w-5 h-5" /> },
      ]
    : []

  const ringkas = stats
    ? [
        { label: 'Jumlah Hari', value: stats.jumlah_hari },
        { label: 'Hari Tersibuk', value: stats.hari_tersibuk },
        { label: 'Periode Aktif', value: stats.periode_aktif },
        { label: 'Selesai', value: stats.selesai },
        { label: 'Antri', value: stats.antri },
        { label: 'Rata-rata Durasi', value: stats.rata_rata_durasi },
        { label: 'Layanan Terbanyak', value: stats.layanan_terbanyak },
        { label: 'Instansi Terbanyak', value: stats.instansi_terbanyak },
      ]
    : []

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="admin-h1">Dashboard</h1>
          <p className="admin-subtitle">Ringkasan Data BPS Provinsi Maluku Utara</p>
        </div>
        {/* Date filter — compact inline */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="date_from">Dari</Label>
            <Input id="date_from" type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="w-36 h-9" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="date_to">Sampai</Label>
            <Input id="date_to" type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="w-36 h-9" />
          </div>
          <Button size="sm" onClick={handleFilter} className="bg-orange-600 hover:bg-orange-700 text-white">Filter</Button>
          <Button size="sm" variant="outline" onClick={handleReset}>Reset</Button>
        </div>
      </div>

      {statsLoading ? (
        <DashboardSkeleton />
      ) : (
        <>
          {/* Lapis 1 — sorotan */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {sorotan.map(s => (
              <StatsCard key={s.label} label={s.label} value={s.value} icon={s.icon} accent="primary" />
            ))}
          </div>

          {/* Lapis 2 — grafik */}
          <div className="grid grid-cols-1 xl:grid-cols-[1.6fr_1fr] gap-5">
            <div className="admin-card p-5">
              <h2 className="text-sm font-bold mb-1" style={{ color: 'var(--admin-text)' }}>Tren Kunjungan</h2>
              <p className="text-xs mb-3" style={{ color: 'var(--admin-text-muted)' }}>
                Jumlah kunjungan per {satuan}
              </p>
              {eventsLoading ? <Skeleton className="h-[200px] rounded-xl" /> : <TrendChart data={tren} satuan={satuan} isError={eventsError} />}
            </div>
            <div className="admin-card p-5">
              <h2 className="text-sm font-bold mb-1" style={{ color: 'var(--admin-text)' }}>Komposisi Layanan</h2>
              <p className="text-xs mb-3" style={{ color: 'var(--admin-text-muted)' }}>
                Bagian tiap layanan dari total
              </p>
              {eventsLoading ? <Skeleton className="h-[200px] rounded-xl" /> : <ServiceBars data={layanan} isError={eventsError} />}
            </div>
          </div>

          {/* Lapis 3 — ringkas */}
          <div className="admin-card p-5">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-4">
              {ringkas.map(r => <MiniStat key={r.label} label={r.label} value={r.value} />)}
            </div>
          </div>
        </>
      )}

      {/* Lapis 4 — kalender lebar penuh */}
      <div className="admin-card p-5">
        <h2 className="text-sm font-bold mb-3" style={{ color: 'var(--admin-text)' }}>Kalender Kunjungan</h2>
        {eventsLoading ? (
          <Skeleton className="h-64 rounded-xl" />
        ) : (
          <FullCalendar
            // `key` berubah HANYA saat filterParams berubah (bukan tiap render),
            // supaya navigasi bulan manual pengguna tidak direset oleh re-render
            // yang tak terkait, tapi tetap loncat ke bulan filter saat filter
            // baru ditekan.
            key={calendarKey}
            plugins={[dayGridPlugin]}
            initialView="dayGridMonth"
            initialDate={calendarInitialDate}
            events={events ?? []}
            locale="id"
            headerToolbar={{ left: 'prev,next today', center: 'title', right: '' }}
            height="auto"
          />
        )}
      </div>
    </div>
  )
}
