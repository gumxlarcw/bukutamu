import {
  STATUS_DATA_OPTIONS,
  JENIS_PUBLIKASI_OPTIONS,
  LEVEL_DATA_OPTIONS,
  PERIODE_DATA_OPTIONS,
  isPemerintahKategori,
  type ConsultationDataRow,
} from '@/types/visit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Plus, Trash2 } from 'lucide-react'

function emptyRow(): ConsultationDataRow {
  return {
    rincian_data: '',
    // Field non-spec form SKD versi baru: simpan null supaya panel admin & export
    // tidak menampilkan default palsu (mis. tahun saat ini, level Nasional, periode
    // Tahunan) yang sebenarnya tidak pernah diisi petugas. Schema DB nullable.
    wilayah_data: null,
    tahun_awal: null,
    tahun_akhir: null,
    level_data: null,
    periode_data: null,
    status_data: 4, // default "Belum Diperoleh"
    jenis_publikasi: null,
    judul_publikasi: null,
    tahun_publikasi: null,
    digunakan_nasional: null,
    kualitas: null, // diisi tamu via tablet evaluasi nanti
  }
}

interface ConsultationDataFormProps {
  rows: ConsultationDataRow[]
  hasilKonsultasi: string
  kategoriInstansi: number | string | null | undefined
  onChange: (rows: ConsultationDataRow[]) => void
  onHasilChange: (val: string) => void
}

interface PillRadioProps<T extends string | number> {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T | null
  onChange: (val: T) => void
  columns?: number
}

function PillRadio<T extends string | number>({ options, value, onChange, columns = 2 }: PillRadioProps<T>) {
  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {options.map(opt => {
        const active = value === opt.value
        return (
          <button
            key={String(opt.value)}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`px-3 py-2 rounded-lg text-sm font-medium border transition-all active:scale-95 cursor-pointer text-left ${
              active
                ? 'bg-orange-500 text-white border-orange-500 shadow-md shadow-orange-500/20'
                : 'bg-background text-foreground border-border hover:bg-orange-50 hover:border-orange-300'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

export function ConsultationDataForm({
  rows,
  hasilKonsultasi,
  kategoriInstansi,
  onChange,
  onHasilChange,
}: ConsultationDataFormProps) {
  const updateRow = (index: number, patch: Partial<ConsultationDataRow>) => {
    const updated = rows.map((r, i) => (i === index ? { ...r, ...patch } : r))
    onChange(updated)
  }

  const removeRow = (index: number) => {
    onChange(rows.filter((_, i) => i !== index))
  }

  const addRow = () => {
    onChange([...rows, emptyRow()])
  }

  const showSumberData = (status: number) => status === 1 || status === 2
  const showDigunakanNasional = (status: number) =>
    showSumberData(status) && isPemerintahKategori(kategoriInstansi)

  const jenisPublikasiOptions = JENIS_PUBLIKASI_OPTIONS.map(name => ({ value: name, label: name }))
  const digunakanNasionalOptions = [
    { value: 1, label: 'Ya' },
    { value: 0, label: 'Tidak' },
  ] as const

  return (
    <div className="space-y-5">
      {rows.length === 0 && (
        <p className="text-sm text-muted-foreground italic text-center py-4">
          Belum ada data konsultasi. Klik "Tambah Data" untuk mulai mencatat kebutuhan tamu.
        </p>
      )}

      {rows.map((row, idx) => (
        <div key={idx} className="border rounded-xl p-4 space-y-4 bg-muted/20">
          <div className="flex items-center justify-between">
            <p className="font-bold text-sm">No. {idx + 1}</p>
            <Button
              size="sm"
              variant="ghost"
              className="text-red-600 hover:text-red-700 hover:bg-red-50"
              onClick={() => removeRow(idx)}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>

          {/* 2. Data yang dibutuhkan/dikonsultasikan */}
          <div className="space-y-1">
            <Label>Data yang dibutuhkan/dikonsultasikan <span className="text-red-500">*</span></Label>
            <Input
              value={row.rincian_data}
              onChange={e => updateRow(idx, { rincian_data: e.target.value })}
              placeholder="Contoh: Indeks Pembangunan Manusia Halmahera 2020-2024"
            />
          </div>

          {(row.wilayah_data || row.level_data != null || row.periode_data != null || row.tahun_awal != null || row.tahun_akhir != null) && (
            <div className="rounded-lg border border-orange-200 bg-orange-50/50 p-3 space-y-0.5 text-sm">
              <p className="font-semibold text-orange-700 text-xs uppercase tracking-wide">Detail permintaan dari pengunjung</p>
              {row.level_data != null && (
                <p><span className="text-muted-foreground">Cakupan: </span>{LEVEL_DATA_OPTIONS.find(o => o.value === row.level_data)?.label ?? row.level_data}</p>
              )}
              {row.wilayah_data && (
                <p><span className="text-muted-foreground">Wilayah: </span>{row.wilayah_data}</p>
              )}
              {row.periode_data != null && (
                <p><span className="text-muted-foreground">Periode: </span>{PERIODE_DATA_OPTIONS.find(o => o.value === row.periode_data)?.label ?? row.periode_data}</p>
              )}
              {(row.tahun_awal != null || row.tahun_akhir != null) && (
                <p><span className="text-muted-foreground">Tahun: </span>{row.tahun_awal ?? '?'}{row.tahun_akhir != null && row.tahun_akhir !== row.tahun_awal ? `–${row.tahun_akhir}` : ''}</p>
              )}
            </div>
          )}

          {/* 3. Apakah data sudah diperoleh? */}
          <div className="space-y-1.5">
            <Label>Apakah data sudah diperoleh? <span className="text-red-500">*</span></Label>
            <PillRadio
              options={STATUS_DATA_OPTIONS}
              value={row.status_data}
              onChange={(val) => {
                // Reset field 4-7 jika status berubah ke 3/4 (tidak/belum diperoleh)
                if (val === 3 || val === 4) {
                  updateRow(idx, {
                    status_data: val,
                    jenis_publikasi: null,
                    judul_publikasi: null,
                    tahun_publikasi: null,
                    digunakan_nasional: null,
                  })
                } else {
                  updateRow(idx, { status_data: val })
                }
              }}
              columns={2}
            />
          </div>

          {/* 4-6. Hanya muncul kalau data sudah diperoleh (status 1 atau 2) */}
          {showSumberData(row.status_data) && (
            <div className="border-t pt-4 space-y-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Detail Sumber Data
              </p>

              {/* 4. Jenis Sumber Data */}
              <div className="space-y-1.5">
                <Label>Jenis Sumber Data <span className="text-red-500">*</span></Label>
                <PillRadio
                  options={jenisPublikasiOptions}
                  value={row.jenis_publikasi}
                  onChange={val => updateRow(idx, { jenis_publikasi: val })}
                  columns={2}
                />
              </div>

              {/* 5. Judul Sumber Data */}
              <div className="space-y-1">
                <Label>Judul Sumber Data <span className="text-muted-foreground text-xs font-normal">(isikan sesuai responden)</span></Label>
                <Input
                  value={row.judul_publikasi ?? ''}
                  onChange={e => updateRow(idx, { judul_publikasi: e.target.value || null })}
                  placeholder="Judul publikasi/sumber data"
                />
              </div>

              {/* 6. Tahun Sumber Data */}
              <div className="space-y-1 max-w-[200px]">
                <Label>Tahun Sumber Data</Label>
                <Input
                  type="number"
                  min={2000}
                  max={new Date().getFullYear()}
                  value={row.tahun_publikasi ?? ''}
                  onChange={e =>
                    updateRow(idx, {
                      tahun_publikasi: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                />
              </div>

              {/* 7. Digunakan untuk perencanaan/evaluasi (hanya pemerintah) */}
              {showDigunakanNasional(row.status_data) && (
                <div className="space-y-1.5">
                  <Label>
                    Apakah data ini digunakan untuk perencanaan dan evaluasi pembangunan nasional/daerah?
                  </Label>
                  <PillRadio
                    options={digunakanNasionalOptions}
                    value={row.digunakan_nasional}
                    onChange={val => updateRow(idx, { digunakan_nasional: val })}
                    columns={2}
                  />
                </div>
              )}
            </div>
          )}

          {/* Info kalau status 3/4: Tingkat Kepuasan Kualitas akan di-skip */}
          {(row.status_data === 1 || row.status_data === 2) && (
            <p className="text-[11px] text-muted-foreground italic border-t pt-2">
              ℹ️ Tingkat kepuasan kualitas data akan ditanyakan ke tamu di tablet evaluasi.
            </p>
          )}
        </div>
      ))}

      <Button
        variant="outline"
        onClick={addRow}
        className="w-full border-dashed"
      >
        <Plus className="w-4 h-4 mr-2" />
        Tambah Data
      </Button>

      {/* Hasil konsultasi */}
      <div className="space-y-1">
        <Label htmlFor="hasil_konsultasi" className="text-sm font-semibold">
          Hasil / Ringkasan Konsultasi
        </Label>
        <textarea
          id="hasil_konsultasi"
          rows={4}
          className="w-full border rounded-md px-3 py-2 text-sm bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder="Catatan ringkas hasil konsultasi (opsional)..."
          value={hasilKonsultasi}
          onChange={e => onHasilChange(e.target.value)}
        />
      </div>
    </div>
  )
}
