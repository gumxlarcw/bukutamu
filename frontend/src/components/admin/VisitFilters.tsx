import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SERVICE_OPTIONS } from '@/types/visit'

interface VisitFilterState {
  q: string
  layanan: string
  status: string
  tahun: string
  bulan: string
}

interface VisitFiltersProps {
  filters: VisitFilterState
  onChange: (filters: VisitFilterState) => void
}

const BULAN_OPTIONS = [
  { value: '1', label: 'Januari' },
  { value: '2', label: 'Februari' },
  { value: '3', label: 'Maret' },
  { value: '4', label: 'April' },
  { value: '5', label: 'Mei' },
  { value: '6', label: 'Juni' },
  { value: '7', label: 'Juli' },
  { value: '8', label: 'Agustus' },
  { value: '9', label: 'September' },
  { value: '10', label: 'Oktober' },
  { value: '11', label: 'November' },
  { value: '12', label: 'Desember' },
]

const currentYear = new Date().getFullYear()
const TAHUN_OPTIONS = Array.from({ length: 5 }, (_, i) => currentYear - i)

export function VisitFilters({ filters, onChange }: VisitFiltersProps) {
  const update = (key: keyof VisitFilterState, value: string) => {
    onChange({ ...filters, [key]: value })
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1 min-w-[200px]">
        <Label htmlFor="search-q">Cari</Label>
        <Input
          id="search-q"
          placeholder="Nama, instansi..."
          value={filters.q}
          onChange={e => update('q', e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="filter-layanan">Layanan</Label>
        <select
          id="filter-layanan"
          value={filters.layanan}
          onChange={e => update('layanan', e.target.value)}
          className="h-9 border rounded px-3 text-sm bg-background"
        >
          <option value="">Semua Layanan</option>
          {SERVICE_OPTIONS.map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="filter-status">Status</Label>
        {/* Ketujuh opsi mencerminkan PERSIS enum kolom tamdes_kunjungan.status.
            Jangan validasi nilainya di backend memakai Api_base::valid_statuses() —
            helper itu hanya memuat 6 nilai dan kehilangan 'evaluasi_selesai',
            sehingga akan menolak filter yang sah dari dropdown ini. */}
        <select
          id="filter-status"
          title="Tujuh status alur kunjungan, sama persis dengan enum di basis data"
          value={filters.status}
          onChange={e => update('status', e.target.value)}
          className="h-9 border rounded px-3 text-sm bg-background"
        >
          <option value="">Semua Status</option>
          <option value="antri">Antri</option>
          <option value="dipanggil">Dipanggil</option>
          <option value="proses">Proses</option>
          <option value="diproses">Diproses</option>
          <option value="menunggu_evaluasi">Menunggu Evaluasi</option>
          <option value="evaluasi_selesai">Evaluasi Selesai</option>
          <option value="selesai">Selesai</option>
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="filter-tahun">Tahun</Label>
        <select
          id="filter-tahun"
          value={filters.tahun}
          onChange={e => update('tahun', e.target.value)}
          className="h-9 border rounded px-3 text-sm bg-background"
        >
          <option value="">Semua Tahun</option>
          {TAHUN_OPTIONS.map(y => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="filter-bulan">Bulan</Label>
        <select
          id="filter-bulan"
          value={filters.bulan}
          onChange={e => update('bulan', e.target.value)}
          className="h-9 border rounded px-3 text-sm bg-background"
        >
          <option value="">Semua Bulan</option>
          {BULAN_OPTIONS.map(b => (
            <option key={b.value} value={b.value}>{b.label}</option>
          ))}
        </select>
      </div>
    </div>
  )
}

export type { VisitFilterState }
