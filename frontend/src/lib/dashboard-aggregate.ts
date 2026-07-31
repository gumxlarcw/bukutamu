import type { CalendarEvent } from '@/types/visit'

const NAMA_BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']

/** Ambang pengelompokan: sampai 62 hari tampil harian, lebih dari itu bulanan. */
const AMBANG_HARI = 62

function rentangHari(events: CalendarEvent[]): number {
  if (events.length === 0) return 0
  const waktu = events.map(e => new Date(`${e.start}T00:00:00+09:00`).getTime()).filter(t => !Number.isNaN(t))
  if (waktu.length === 0) return 0
  return (Math.max(...waktu) - Math.min(...waktu)) / 86_400_000
}

/**
 * Satuan sumbu tren. Diukur dari tanggal paling awal sampai paling akhir yang
 * BENAR-BENAR ada di data, bukan dari isian filter — sehingga tanpa filter
 * (mencakup seluruh riwayat) grafik otomatis tampil bulanan.
 */
export function satuanTren(events: CalendarEvent[]): 'hari' | 'bulan' {
  return rentangHari(events) <= AMBANG_HARI ? 'hari' : 'bulan'
}

/** Total kunjungan per periode, urut kronologis. */
export function agregatTren(events: CalendarEvent[]): { label: string; value: number }[] {
  const satuan = satuanTren(events)
  const ember = new Map<string, number>()

  for (const e of events) {
    const [th, bl, hr] = e.start.split('-')
    if (!th || !bl) continue
    const kunci = satuan === 'hari' ? `${th}-${bl}-${hr}` : `${th}-${bl}`
    ember.set(kunci, (ember.get(kunci) ?? 0) + (Number(e.count) || 0))
  }

  return [...ember.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([kunci, value]) => {
      const bagian = kunci.split('-')
      const bulan = NAMA_BULAN[Number(bagian[1]) - 1] ?? bagian[1]
      const label = satuan === 'hari' ? `${Number(bagian[2])} ${bulan}` : `${bulan} ${bagian[0]}`
      return { label, value }
    })
}

/** Total kunjungan per layanan, urut terbanyak dulu, dengan persentase. */
export function agregatLayanan(events: CalendarEvent[]): { label: string; value: number; pct: number }[] {
  const ember = new Map<string, number>()
  for (const e of events) {
    const nama = (e.layanan || '').trim() || 'Tidak diketahui'
    ember.set(nama, (ember.get(nama) ?? 0) + (Number(e.count) || 0))
  }
  const total = [...ember.values()].reduce((t, n) => t + n, 0)
  return [...ember.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label, value, pct: total > 0 ? (value / total) * 100 : 0 }))
}
