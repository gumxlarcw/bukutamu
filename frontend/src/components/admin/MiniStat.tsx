interface MiniStatProps {
  label: string
  value: string | number
}

/**
 * Pasangan label + nilai untuk statistik sekunder. Sengaja BUKAN StatsCard:
 * nilai seperti "Instansi Terbanyak" berisi teks panjang, dan memaksanya ke
 * kartu berikon membuat StatsCard harus mengecilkan fontnya sendiri
 * (lihat akal-akalan `isLong` di StatsCard.tsx). Di sini teks panjang justru
 * punya ruang.
 */
export function MiniStat({ label, value }: MiniStatProps) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-medium uppercase tracking-wide mb-0.5" style={{ color: 'var(--admin-text-muted)' }}>
        {label}
      </p>
      <p className="text-sm font-semibold leading-snug break-words" style={{ color: 'var(--admin-text)' }}>
        {value}
      </p>
    </div>
  )
}
