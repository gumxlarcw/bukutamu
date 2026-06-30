import apiClient from './client'
import type { ApiResponse } from '@/types/api'

export interface QueueStatsAvgWait {
  avg_durasi: number | null
  min_durasi: number | null
  max_durasi: number | null
  total_selesai: number | null
}

export interface QueueStatsHourly { jam: number; jumlah: number }
export interface QueueStatsDaily { hari: string; dow: number; jumlah: number }
export interface QueueStatsMonthly { bulan: number; jumlah: number; avg_durasi: number | null }
export interface QueueStatsQuarterly { triwulan: number; jumlah: number; selesai: number; avg_durasi: number | null }
export interface QueueStatsService { jenis_layanan: string; jumlah: number }
export interface QueueStatsStatus { status: string; jumlah: number }
export interface QueueStatsSource { source: string; jumlah: number }
export interface QueueStatsSarana { code: number; jumlah: number }
export interface QueueStatsInstansi { nama_instansi: string; kategori_instansi: string | null; jumlah: number }
export interface QueueStatsKategori { kategori_instansi: string; jumlah: number }
export interface QueueStatsGender { gender: string; jumlah: number }

export interface QueueStats {
  avg_wait: QueueStatsAvgWait | null
  total_visits: number
  distinct_visitors: number
  repeat_visitors: number
  hourly: QueueStatsHourly[]
  daily: QueueStatsDaily[]
  monthly: QueueStatsMonthly[]
  quarterly: QueueStatsQuarterly[]
  services: QueueStatsService[]
  statuses: QueueStatsStatus[]
  sources: QueueStatsSource[]
  sarana_dist: QueueStatsSarana[]
  top_instansi: QueueStatsInstansi[]
  kategori_instansi: QueueStatsKategori[]
  gender_dist: QueueStatsGender[]
}

// ── CI3 numeric coercion at the boundary ────────────────────────────────────
// CodeIgniter's mysqli driver returns raw `->result()`/`->row()` columns as
// STRINGS ("4", "612.34"). The interfaces above declare them as `number`, so
// every consumer that does `a + b`, `a > b`, or `===` on these would silently
// break ('0'+'3'+'15' concatenates to '0315'; '9' > '100' is lexicographically
// true). We coerce once here so the declared `number` types are honest and no
// downstream card has to remember to wrap in Number(). See auto-memory
// `ci3_numeric_strings_coercion`.
const n = (v: unknown): number => (v == null ? 0 : Number(v))
const nN = (v: unknown): number | null => (v == null ? null : Number(v))

function normalizeQueueStats(d: QueueStats): QueueStats {
  return {
    ...d,
    total_visits: n(d.total_visits),
    distinct_visitors: n(d.distinct_visitors),
    repeat_visitors: n(d.repeat_visitors),
    avg_wait: d.avg_wait
      ? {
          avg_durasi: nN(d.avg_wait.avg_durasi),
          min_durasi: nN(d.avg_wait.min_durasi),
          max_durasi: nN(d.avg_wait.max_durasi),
          total_selesai: nN(d.avg_wait.total_selesai),
        }
      : null,
    hourly: (d.hourly ?? []).map((h) => ({ jam: n(h.jam), jumlah: n(h.jumlah) })),
    daily: (d.daily ?? []).map((x) => ({ hari: x.hari, dow: n(x.dow), jumlah: n(x.jumlah) })),
    monthly: (d.monthly ?? []).map((m) => ({ bulan: n(m.bulan), jumlah: n(m.jumlah), avg_durasi: nN(m.avg_durasi) })),
    quarterly: (d.quarterly ?? []).map((q) => ({ triwulan: n(q.triwulan), jumlah: n(q.jumlah), selesai: n(q.selesai), avg_durasi: nN(q.avg_durasi) })),
    services: (d.services ?? []).map((s) => ({ jenis_layanan: s.jenis_layanan, jumlah: n(s.jumlah) })),
    statuses: (d.statuses ?? []).map((s) => ({ status: s.status, jumlah: n(s.jumlah) })),
    sources: (d.sources ?? []).map((s) => ({ source: s.source, jumlah: n(s.jumlah) })),
    sarana_dist: (d.sarana_dist ?? []).map((s) => ({ code: n(s.code), jumlah: n(s.jumlah) })),
    top_instansi: (d.top_instansi ?? []).map((s) => ({ nama_instansi: s.nama_instansi, kategori_instansi: s.kategori_instansi, jumlah: n(s.jumlah) })),
    kategori_instansi: (d.kategori_instansi ?? []).map((s) => ({ kategori_instansi: s.kategori_instansi, jumlah: n(s.jumlah) })),
    gender_dist: (d.gender_dist ?? []).map((s) => ({ gender: s.gender, jumlah: n(s.jumlah) })),
  }
}

export const queueStatsApi = {
  get: (params: { tahun?: string }) =>
    apiClient.get<ApiResponse<QueueStats>>('/api/queue-stats', { params }).then((res) => {
      if (res.data?.data) res.data.data = normalizeQueueStats(res.data.data)
      return res
    }),
}
