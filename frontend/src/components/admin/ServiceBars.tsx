interface Baris { label: string; value: number; pct: number }

interface ServiceBarsProps {
  data: Baris[]
  isError?: boolean
}

/**
 * Batang horizontal SATU HUE. Identitas dibawa label yang berdiri tepat di
 * samping batangnya, jadi warna berbeda-beda per layanan hanya dekoratif —
 * dan sembilan hue kategorikal melewati batas aman keterbacaan buta warna.
 * Satu hue membuat panjang batang jadi satu-satunya isyarat, yang memang
 * pekerjaannya: membandingkan besaran.
 */
export function ServiceBars({ data, isError }: ServiceBarsProps) {
  if (isError) {
    return (
      <div className="flex items-center justify-center h-[200px] text-sm" style={{ color: 'var(--admin-text-muted)' }}>
        Gagal memuat data. Coba muat ulang halaman.
      </div>
    )
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[200px] text-sm" style={{ color: 'var(--admin-text-muted)' }}>
        Belum ada data pada rentang ini
      </div>
    )
  }

  const maks = Math.max(...data.map(d => d.value), 1)

  return (
    <ul className="space-y-2.5">
      {data.map(d => (
        <li key={d.label} className="group">
          <div className="flex items-baseline justify-between gap-3 mb-1">
            <span className="text-xs truncate" style={{ color: 'var(--admin-text-secondary)' }}>{d.label}</span>
            <span className="text-xs tabular-nums shrink-0" style={{ color: 'var(--admin-text-muted)' }}>
              <span className="font-semibold" style={{ color: 'var(--admin-text)' }}>{d.value}</span>
              {' · '}{d.pct.toFixed(0)}%
            </span>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--admin-border)' }}>
            <div
              className="h-full rounded-full transition-[width] duration-300"
              style={{ width: `${(d.value / maks) * 100}%`, background: 'var(--admin-primary)' }}
              title={`${d.label}: ${d.value} kunjungan (${d.pct.toFixed(1)}%)`}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}
