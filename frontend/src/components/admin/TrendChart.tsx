import { useCallback, useLayoutEffect, useState, type MouseEvent } from 'react'

interface Titik { label: string; value: number }

interface TrendChartProps {
  data: Titik[]
  satuan: 'hari' | 'bulan'
  isError?: boolean
}

const H = 200
const PAD = { atas: 16, kanan: 12, bawah: 26, kiri: 12 }

export function TrendChart({ data, satuan, isError }: TrendChartProps) {
  const [aktif, setAktif] = useState<number | null>(null)

  // Callback ref (bukan useRef biasa) supaya efek pengukuran berjalan lagi
  // setiap kali node DOM yang diamati berganti — termasuk saat komponen
  // berpindah antar cabang render (kosong/terukur/grafik) tanpa unmount.
  const [wadah, setWadah] = useState<HTMLDivElement | null>(null)
  const [w, setW] = useState(0)

  useLayoutEffect(() => {
    if (!wadah) return
    // observe() sendiri melaporkan ukuran awal secara async lewat callback —
    // tidak perlu setState sinkron di badan efek untuk baca lebar pertama kali.
    const ro = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width
      if (width) setW(width)
    })
    ro.observe(wadah)
    return () => ro.disconnect()
  }, [wadah])

  const wadahRef = useCallback((el: HTMLDivElement | null) => setWadah(el), [])

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

  // Belum terukur (render pertama sebelum ResizeObserver melapor) — tampilkan
  // wadah kosong supaya ref terpasang, tapi jangan hitung apa pun yang bisa
  // membagi dengan lebar nol dan menghasilkan NaN.
  if (w === 0) {
    return <div ref={wadahRef} className="h-[200px]" />
  }

  // viewBox lebar = lebar piksel wadah yang terukur (bukan konstanta tetap),
  // jadi SVG memetakan 1:1 ke piksel nyata — tidak ada gutter kosong dan
  // hit-test/tooltip tidak meleset.
  const W = Math.round(w)

  const inW = W - PAD.kiri - PAD.kanan
  const inH = H - PAD.atas - PAD.bawah
  const maks = Math.max(...data.map(d => d.value), 1)

  // Satu titik tidak punya rentang horizontal — gambar sebagai garis datar di
  // tengah, bukan membagi dengan nol.
  const x = (i: number) => (data.length === 1 ? PAD.kiri + inW / 2 : PAD.kiri + (i / (data.length - 1)) * inW)
  const y = (v: number) => PAD.atas + inH - (v / maks) * inH

  const garis = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(d.value).toFixed(1)}`).join(' ')
  const area = data.length === 1
    ? ''
    : `${garis} L ${x(data.length - 1).toFixed(1)} ${PAD.atas + inH} L ${x(0).toFixed(1)} ${PAD.atas + inH} Z`

  // Label sumbu hanya di ujung dan tengah — menomori setiap titik membuat
  // sumbunya berdesakan dan tidak terbaca.
  const idxLabel = data.length <= 2 ? data.map((_, i) => i) : [0, Math.floor((data.length - 1) / 2), data.length - 1]

  const pilih = (e: MouseEvent<SVGSVGElement>) => {
    const kotak = e.currentTarget.getBoundingClientRect()
    const rel = ((e.clientX - kotak.left) / kotak.width) * W
    if (data.length === 1) { setAktif(0); return }
    const i = Math.round(((rel - PAD.kiri) / inW) * (data.length - 1))
    setAktif(Math.min(data.length - 1, Math.max(0, i)))
  }

  return (
    <div className="relative" ref={wadahRef}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-[200px]"
        onMouseMove={pilih}
        onMouseLeave={() => setAktif(null)}
        role="img"
        aria-label={`Tren kunjungan per ${satuan}, ${data.length} periode`}
      >
        <defs>
          <linearGradient id="tren-isi" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--admin-primary)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--admin-primary)" stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {/* Garis dasar recessive — satu-satunya "grid" yang dibutuhkan. */}
        <line x1={PAD.kiri} y1={PAD.atas + inH} x2={W - PAD.kanan} y2={PAD.atas + inH}
              stroke="var(--admin-border-strong)" strokeWidth="1" />

        {area && <path d={area} fill="url(#tren-isi)" />}
        <path d={garis} fill="none" stroke="var(--admin-primary)" strokeWidth="2"
              strokeLinejoin="round" strokeLinecap="round" />

        {idxLabel.map(i => (
          <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'}
                fontSize="11" fill="var(--admin-text-muted)">
            {data[i].label}
          </text>
        ))}

        {aktif !== null && (
          <>
            <line x1={x(aktif)} y1={PAD.atas} x2={x(aktif)} y2={PAD.atas + inH}
                  stroke="var(--admin-border-strong)" strokeWidth="1" />
            {/* Cincin permukaan 2px supaya penanda tetap terbaca di atas area. */}
            <circle cx={x(aktif)} cy={y(data[aktif].value)} r="5"
                    fill="var(--admin-primary)" stroke="var(--admin-surface)" strokeWidth="2" />
          </>
        )}
      </svg>

      {aktif !== null && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-lg px-2.5 py-1.5 text-xs shadow-md"
          style={{
            left: `${(x(aktif) / W) * 100}%`,
            top: `${(y(data[aktif].value) / H) * 100}%`,
            background: 'var(--admin-surface)',
            border: '1px solid var(--admin-border-strong)',
            color: 'var(--admin-text)',
          }}
        >
          <span style={{ color: 'var(--admin-text-muted)' }}>{data[aktif].label}</span>
          <span className="ml-2 font-semibold">{data[aktif].value}</span>
        </div>
      )}
    </div>
  )
}
