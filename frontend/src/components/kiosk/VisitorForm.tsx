import { useEffect } from 'react'
import type { GuestFormData } from '@/types/guest'
import {
  PENDIDIKAN_OPTIONS,
  UMUR_OPTIONS,
  DISABILITAS_OPTIONS,
  JENIS_DISABILITAS_OPTIONS,
  PEKERJAAN_OPTIONS,
  KATEGORI_INSTANSI_OPTIONS,
  PEMANFAATAN_OPTIONS,
} from '@/types/guest'

const STORAGE_KEY = 'kiosk_visitor_form'

interface VisitorFormProps {
  value: GuestFormData
  onChange: (data: GuestFormData) => void
  // Kiosk persists/restores a draft via localStorage (shared touchscreen). The
  // public WA intake page passes false so it never reads/writes that key —
  // avoids clobbering the server prefill and leaking PII between requesters.
  restoreFromStorage?: boolean
}

function getNowIso(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
}

export function VisitorForm({ value, onChange, restoreFromStorage = true }: VisitorFormProps) {
  useEffect(() => {
    if (restoreFromStorage) {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as GuestFormData
          onChange({ ...parsed, tgldatang: getNowIso() })
          return
        } catch { /* ignore */ }
      }
    }
    onChange({ ...value, tgldatang: getNowIso() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (restoreFromStorage) localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  }, [value, restoreFromStorage])

  const update = <K extends keyof GuestFormData>(key: K, val: GuestFormData[K]) => {
    onChange({ ...value, [key]: val })
  }

  const fieldClass = "w-full px-3 py-2.5 text-sm rounded-lg border border-gray-300 bg-white/60 text-gray-800 placeholder-gray-400 focus:outline-none focus:border-orange-400 focus:bg-white/80 transition-colors"
  const labelClass = "block text-gray-700 font-semibold mb-0.5 text-xs"
  const selectClass = `${fieldClass} appearance-none`
  const btnActive = 'border-orange-400 bg-orange-500 text-white'
  const btnInactive = 'border-gray-300 bg-white/60 text-gray-700 hover:bg-white/80'

  return (
    <div className="space-y-2.5 w-full">
      {/* 1. Nama */}
      <div>
        <label className={labelClass}>1. Nama Lengkap *</label>
        <input type="text" className={fieldClass} placeholder="Masukkan nama lengkap" value={value.nama} onChange={e => update('nama', e.target.value)} />
      </div>

      {/* 2. Email */}
      <div>
        <label className={labelClass}>2. Email *</label>
        <input type="email" className={fieldClass} placeholder="contoh@email.com" value={value.email} onChange={e => update('email', e.target.value)} />
      </div>

      {/* 3. No HP */}
      <div>
        <label className={labelClass}>3. Nomor Handphone *</label>
        <input type="tel" className={fieldClass} placeholder="08xxxxxxxxxx" value={value.notel} onChange={e => update('notel', e.target.value)} />
      </div>

      {/* 4. Jenis Kelamin */}
      <div>
        <label className={labelClass}>4. Jenis Kelamin *</label>
        <div className="flex gap-3">
          {(['Laki-laki', 'Perempuan'] as const).map(jk => (
            <button key={jk} type="button" onClick={() => update('jeniskelamin', jk)}
              className={`flex-1 py-2.5 rounded-lg border text-sm font-semibold transition-all ${value.jeniskelamin === jk ? btnActive : btnInactive}`}
            >{jk}</button>
          ))}
        </div>
      </div>

      {/* 5. Pendidikan */}
      <div>
        <label className={labelClass}>5. Pendidikan Tertinggi yang Ditamatkan *</label>
        <select className={selectClass} value={value.pendidikan || ''} onChange={e => update('pendidikan', Number(e.target.value))}>
          <option value="" disabled className="bg-white">-- Pilih Pendidikan --</option>
          {PENDIDIKAN_OPTIONS.map(o => <option key={o.value} value={o.value} className="bg-white">{o.label}</option>)}
        </select>
      </div>

      {/* 6. Umur */}
      <div>
        <label className={labelClass}>6. Umur *</label>
        <select className={selectClass} value={value.umur || ''} onChange={e => update('umur', Number(e.target.value))}>
          <option value="" disabled className="bg-white">-- Pilih Rentang Umur --</option>
          {UMUR_OPTIONS.map(o => <option key={o.value} value={o.value} className="bg-white">{o.label}</option>)}
        </select>
      </div>

      {/* 7. Disabilitas */}
      <div>
        <label className={labelClass}>7. Penyandang/Pendamping Disabilitas? *</label>
        <div className="flex gap-3">
          {DISABILITAS_OPTIONS.map(o => (
            <button key={o.value} type="button"
              onClick={() => onChange({ ...value, disabilitas: o.value, jenis_disabilitas: o.value === 2 ? 0 : value.jenis_disabilitas })}
              className={`flex-1 py-2.5 rounded-lg border text-sm font-semibold transition-all ${value.disabilitas === o.value ? btnActive : btnInactive}`}
            >{o.label}</button>
          ))}
        </div>
        {value.disabilitas === 1 && (
          <div className="mt-2">
            <label className={labelClass}>Jenis Disabilitas *</label>
            <select className={selectClass} value={value.jenis_disabilitas || ''} onChange={e => update('jenis_disabilitas', Number(e.target.value))}>
              <option value="" disabled className="bg-white">-- Pilih Jenis --</option>
              {JENIS_DISABILITAS_OPTIONS.map(o => <option key={o.value} value={o.value} className="bg-white">{o.label}</option>)}
            </select>
          </div>
        )}
      </div>

      {/* 8. Pekerjaan */}
      <div>
        <label className={labelClass}>8. Pekerjaan Utama *</label>
        <select className={selectClass} value={value.pekerjaan || ''} onChange={e => { const v = Number(e.target.value); onChange({ ...value, pekerjaan: v, pekerjaan_lainnya: v !== 7 ? '' : value.pekerjaan_lainnya }) }}>
          <option value="" disabled className="bg-white">-- Pilih Pekerjaan --</option>
          {PEKERJAAN_OPTIONS.map(o => <option key={o.value} value={o.value} className="bg-white">{o.label}</option>)}
        </select>
        {value.pekerjaan === 7 && (
          <input type="text" className={`${fieldClass} mt-2`} placeholder="Sebutkan pekerjaan lainnya" value={value.pekerjaan_lainnya} onChange={e => update('pekerjaan_lainnya', e.target.value)} />
        )}
      </div>

      {/* 9. Kategori Instansi */}
      <div>
        <label className={labelClass}>9. Kategori Instansi *</label>
        <select className={selectClass} value={value.kategori_instansi || ''} onChange={e => { const v = Number(e.target.value); onChange({ ...value, kategori_instansi: v, kategori_lainnya: v !== 9 ? '' : value.kategori_lainnya }) }}>
          <option value="" disabled className="bg-white">-- Pilih Kategori --</option>
          {KATEGORI_INSTANSI_OPTIONS.map(o => <option key={o.value} value={o.value} className="bg-white">{o.label}</option>)}
        </select>
        {value.kategori_instansi === 9 && (
          <input type="text" className={`${fieldClass} mt-2`} placeholder="Sebutkan kategori lainnya" value={value.kategori_lainnya} onChange={e => update('kategori_lainnya', e.target.value)} />
        )}
      </div>

      {/* Nama Instansi */}
      <div>
        <label className={labelClass}>Nama Instansi *</label>
        <input type="text" className={fieldClass} placeholder="Nama perusahaan/instansi" value={value.nama_instansi} onChange={e => update('nama_instansi', e.target.value)} />
      </div>

      {/* 10. Pemanfaatan */}
      <div>
        <label className={labelClass}>10. Pemanfaatan Utama Hasil Kunjungan *</label>
        <select className={selectClass} value={value.pemanfaatan || ''} onChange={e => { const v = Number(e.target.value); onChange({ ...value, pemanfaatan: v, pemanfaatan_lainnya: v !== 5 ? '' : value.pemanfaatan_lainnya }) }}>
          <option value="" disabled className="bg-white">-- Pilih Tujuan --</option>
          {PEMANFAATAN_OPTIONS.map(o => <option key={o.value} value={o.value} className="bg-white">{o.label}</option>)}
        </select>
        {value.pemanfaatan === 5 && (
          <input type="text" className={`${fieldClass} mt-2`} placeholder="Sebutkan tujuan lainnya" value={value.pemanfaatan_lainnya} onChange={e => update('pemanfaatan_lainnya', e.target.value)} />
        )}
      </div>

      {/* Pengaduan */}
      <div>
        <label className={labelClass}>Apakah Ada Pengaduan?</label>
        <div className="flex gap-3">
          {(['Ya', 'Tidak'] as const).map(val => (
            <button key={val} type="button" onClick={() => update('pengaduan', val)}
              className={`flex-1 py-2.5 rounded-lg border text-sm font-semibold transition-all ${value.pengaduan === val ? btnActive : btnInactive}`}
            >{val}</button>
          ))}
        </div>
      </div>
    </div>
  )
}

export { STORAGE_KEY }
