import { LEVEL_DATA_OPTIONS, PERIODE_DATA_OPTIONS } from '@/types/visit'
import type { WaPermintaanRow } from '@/types/wa'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Plus, Trash2 } from 'lucide-react'

// eslint-disable-next-line react-refresh/only-export-components
export function emptyPermintaanRow(): WaPermintaanRow {
  return { rincian_data: '', wilayah_data: '', level_data: null, periode_data: null, tahun_awal: null, tahun_akhir: null }
}

interface Props {
  rows: WaPermintaanRow[]
  onChange: (rows: WaPermintaanRow[]) => void
}

export function PermintaanDataForm({ rows, onChange }: Props) {
  const update = (i: number, patch: Partial<WaPermintaanRow>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const remove = (i: number) => onChange(rows.filter((_, idx) => idx !== i))
  const add = () => onChange([...rows, emptyPermintaanRow()])

  const selectClass = 'w-full px-3 py-2.5 text-sm rounded-lg border border-gray-300 bg-white appearance-none'

  return (
    <div className="space-y-4">
      {rows.map((row, idx) => (
        <div key={idx} className="border rounded-xl p-4 space-y-3 bg-muted/20">
          <div className="flex items-center justify-between">
            <p className="font-bold text-sm">Permintaan No. {idx + 1}</p>
            {rows.length > 1 && (
              <Button size="sm" variant="ghost" className="text-red-600" onClick={() => remove(idx)}>
                <Trash2 className="w-4 h-4" />
              </Button>
            )}
          </div>

          <div className="space-y-1">
            <Label>Data / indikator yang dibutuhkan <span className="text-red-500">*</span></Label>
            <Input value={row.rincian_data} onChange={e => update(idx, { rincian_data: e.target.value })}
                   placeholder="Contoh: Indeks Pembangunan Manusia" />
          </div>

          <div className="space-y-1">
            <Label>Cakupan wilayah</Label>
            <select className={selectClass} value={row.level_data ?? ''}
                    onChange={e => update(idx, { level_data: e.target.value ? Number(e.target.value) : null })}>
              <option value="">-- Pilih level --</option>
              {LEVEL_DATA_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <Input className="mt-2" value={row.wilayah_data} onChange={e => update(idx, { wilayah_data: e.target.value })}
                   placeholder="Wilayah spesifik (mis. Maluku Utara, Ternate, Tidore)" />
          </div>

          <div className="space-y-1">
            <Label>Periode data</Label>
            <select className={selectClass} value={row.periode_data ?? ''}
                    onChange={e => update(idx, { periode_data: e.target.value ? Number(e.target.value) : null })}>
              <option value="">-- Pilih periode --</option>
              {PERIODE_DATA_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>

          <div className="flex gap-3">
            <div className="flex-1 space-y-1">
              <Label>Tahun awal</Label>
              <Input type="number" min={2000} max={2100} value={row.tahun_awal ?? ''}
                     onChange={e => update(idx, { tahun_awal: e.target.value ? Number(e.target.value) : null })} />
            </div>
            <div className="flex-1 space-y-1">
              <Label>Tahun akhir</Label>
              <Input type="number" min={2000} max={2100} value={row.tahun_akhir ?? ''}
                     onChange={e => update(idx, { tahun_akhir: e.target.value ? Number(e.target.value) : null })} />
            </div>
          </div>
        </div>
      ))}

      <Button variant="outline" onClick={add} className="w-full border-dashed">
        <Plus className="w-4 h-4 mr-2" /> Tambah Permintaan
      </Button>
    </div>
  )
}
