import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { servicesApi } from '@/api/services'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { SARANA_OPTIONS } from '@/types/guest'
import { CheckCircle, Lock } from 'lucide-react'
import { wouldBeCross, getAllowedSaranaCodes } from '@/lib/role-access'
import type { Service } from '@/api/services'

export interface ServiceSaranaSelectorValue {
  jenis_layanan: string[]
  layanan_lainnya: string
  sarana: number[]
  sarana_lainnya: string
}

interface Props {
  value: ServiceSaranaSelectorValue
  onChange: (v: ServiceSaranaSelectorValue) => void
  /** WA online (#1): batasi sarana ke media online — buang "PST (datang langsung)" (kode 1). */
  onlineOnly?: boolean
  /** Centang sarana ini otomatis saat layanan dipilih & belum ada sarana (mis. 16=Aplikasi Chat). User tetap bisa tambah/ubah. */
  defaultSarana?: number
}

export function ServiceSaranaSelector({ value, onChange, onlineOnly = false, defaultSarana }: Props) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['services'],
    queryFn: () => servicesApi.list().then(r => r.data.data),
  })

  const allowedSaranaCodes = onlineOnly
    ? getAllowedSaranaCodes(value.jenis_layanan).filter(c => c !== 1)
    : getAllowedSaranaCodes(value.jenis_layanan)

  // Saat grup layanan berubah, buang sarana yang sudah dipilih tapi tidak valid lagi.
  useEffect(() => {
    let prunedSarana = value.sarana.filter(v => allowedSaranaCodes.includes(v))
    const prunedSaranaLainnya = allowedSaranaCodes.includes(32) ? value.sarana_lainnya : ''
    // Default-centang (mis. Aplikasi Chat utk #1) saat layanan baru dipilih & belum ada sarana.
    // Hanya saat layanan berubah → tidak memaksa kembali kalau user sengaja meng-uncheck semua.
    if (defaultSarana != null && prunedSarana.length === 0 && value.jenis_layanan.length > 0 && allowedSaranaCodes.includes(defaultSarana)) {
      prunedSarana = [defaultSarana]
    }
    if (
      prunedSarana.length !== value.sarana.length ||
      prunedSaranaLainnya !== value.sarana_lainnya
    ) {
      onChange({ ...value, sarana: prunedSarana, sarana_lainnya: prunedSaranaLainnya })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.jenis_layanan])

  const toggleService = (s: Service) => {
    const removing = value.jenis_layanan.includes(s.name)
    onChange({
      ...value,
      jenis_layanan: removing
        ? value.jenis_layanan.filter(n => n !== s.name)
        : [...value.jenis_layanan, s.name],
      layanan_lainnya: s.name === 'Lainnya' && removing ? '' : value.layanan_lainnya,
    })
  }

  const toggleSarana = (val: number) => {
    const removing = value.sarana.includes(val)
    onChange({
      ...value,
      sarana: removing
        ? value.sarana.filter(v => v !== val)
        : [...value.sarana, val],
      sarana_lainnya: val === 32 && removing ? '' : value.sarana_lainnya,
    })
  }

  return (
    <>
      {/* Jenis Layanan */}
      <div className="mb-4">
        <p className="text-xs font-bold text-gray-600 uppercase tracking-wide mb-2">Jenis Layanan *</p>
        {isLoading && <LoadingSpinner className="py-6" />}
        {isError && <p className="text-red-600 text-xs py-4">Gagal memuat layanan.</p>}
        {data && (
          <>
            <div className="grid grid-cols-4 gap-2">
              {data.map(service => {
                const active = value.jenis_layanan.includes(service.name)
                const blocked = wouldBeCross(value.jenis_layanan, service.name)
                return (
                  <button
                    key={service.id}
                    onClick={() => !blocked && toggleService(service)}
                    disabled={blocked}
                    title={blocked ? 'Tidak boleh campur kategori — pilih satu grup saja (SKD inti, Konsultasi DTSEN, atau Front-office)' : undefined}
                    className={`relative flex items-center gap-2 p-3 rounded-xl border-2 text-left transition-all overflow-hidden
                      ${active
                        ? 'border-orange-400 bg-orange-500 text-white active:scale-95 cursor-pointer'
                        : blocked
                          ? 'border-gray-200 bg-gray-100/70 text-gray-400 cursor-not-allowed'
                          : 'border-gray-200 bg-white/70 text-gray-800 hover:bg-white/90 active:scale-95 cursor-pointer'
                      }`}
                  >
                    {active && <CheckCircle className="w-4 h-4 shrink-0" />}
                    {blocked && <Lock className="w-3.5 h-3.5 shrink-0" />}
                    <span className="text-xs font-semibold leading-snug break-words">{service.name}</span>
                  </button>
                )
              })}
            </div>
            {value.jenis_layanan.length > 0 && (
              <p className="text-[10px] text-orange-600 mt-1.5 px-1">
                ℹ️ Pilih <em>satu</em> kategori: layanan inti SKD (Perpustakaan/Konsultasi/Rekomendasi/Penjualan), <em>atau</em> Konsultasi DTSEN, <em>atau</em> Layanan front-office (Lainnya/Keperluan Pimpinan).
              </p>
            )}
          </>
        )}
        {value.jenis_layanan.includes('Lainnya') && (
          <input
            type="text"
            className="w-full mt-2 px-3 py-2.5 text-sm rounded-lg border border-gray-300 bg-white/60 text-gray-800 placeholder-gray-400 focus:outline-none focus:border-orange-400 focus:bg-white/80 transition-colors"
            placeholder="Sebutkan layanan lainnya"
            value={value.layanan_lainnya}
            onChange={e => onChange({ ...value, layanan_lainnya: e.target.value })}
          />
        )}
      </div>

      {/* Sarana */}
      <div>
        <p className="text-xs font-bold text-gray-600 uppercase tracking-wide mb-2">Sarana yang Digunakan *</p>
        {value.jenis_layanan.length === 0 && (
          <p className="text-[10px] text-gray-500 italic mb-1.5 px-1">
            Pilih jenis layanan terlebih dahulu untuk mengaktifkan sarana yang tersedia.
          </p>
        )}
        <div className="grid grid-cols-3 gap-2">
          {SARANA_OPTIONS.map(opt => {
            const active = value.sarana.includes(opt.value)
            const disabled = !allowedSaranaCodes.includes(opt.value)
            return (
              <button
                key={opt.value}
                onClick={() => !disabled && toggleSarana(opt.value)}
                disabled={disabled}
                title={
                  disabled && value.jenis_layanan.length === 0
                    ? 'Pilih jenis layanan dulu'
                    : disabled
                      ? 'Sarana ini tidak tersedia untuk layanan yang Anda pilih'
                      : undefined
                }
                className={`relative flex items-center gap-2 p-3 rounded-xl border-2 text-left transition-all overflow-hidden
                  ${active
                    ? 'border-orange-400 bg-orange-500 text-white active:scale-95 cursor-pointer'
                    : disabled
                      ? 'border-gray-200 bg-gray-100/70 text-gray-400 cursor-not-allowed'
                      : 'border-gray-200 bg-white/70 text-gray-800 hover:bg-white/90 active:scale-95 cursor-pointer'
                  }`}
              >
                {active && <CheckCircle className="w-4 h-4 shrink-0" />}
                {disabled && <Lock className="w-3.5 h-3.5 shrink-0" />}
                <span className="text-xs font-semibold leading-snug break-words">{opt.label}</span>
              </button>
            )
          })}
        </div>
        {value.sarana.includes(32) && (
          <input
            type="text"
            className="w-full mt-2 px-3 py-2.5 text-sm rounded-lg border border-gray-300 bg-white/60 text-gray-800 placeholder-gray-400 focus:outline-none focus:border-orange-400 focus:bg-white/80 transition-colors"
            placeholder="Sebutkan sarana lainnya"
            value={value.sarana_lainnya}
            onChange={e => onChange({ ...value, sarana_lainnya: e.target.value })}
          />
        )}
      </div>
    </>
  )
}
