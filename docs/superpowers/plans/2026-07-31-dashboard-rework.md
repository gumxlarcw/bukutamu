# Dashboard Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Susun ulang `/admin` menjadi empat lapis — 4 sorotan, 2 grafik SVG, baris ringkas 8 statistik, kalender lebar penuh — sehingga halamannya punya hierarki dan menjawab "naik atau turun".

**Architecture:** Grafik dibuat sendiri dengan SVG, tanpa dependensi baru. Agregasi dilakukan sebagai fungsi murni di modul terpisah; komponen grafik hanya menerima data jadi. Backend cukup menambah dua field ke `Dashboard::events()` dan menghormati filter tanggal.

**Tech Stack:** CodeIgniter 3 (PHP 7.4-FPM), React 19 + TypeScript 5.9, Vite, `@tanstack/react-query` v5, Tailwind 4, SVG polos.

**Spec:** `docs/superpowers/specs/2026-07-31-dashboard-rework-design.md`

## Global Constraints

- **Repo ini tidak punya tes otomatis.** Tidak ada PHPUnit/Vitest/`npm test`. Jangan mengarang skrip tes. Verifikasi = `php7.4 -l`, `npm run lint`, `npm run build`, `curl`, query MySQL, pemeriksaan browser.
- **Backup sebelum tiap edit:** `cp {file} {file}.backup`, lalu `diff` sesudahnya. **KECUALI di `frontend/public/`** — Vite menyalin direktori itu apa adanya ke `dist/` dan PM2 menerbitkannya, jadi backup di sana bisa diunduh publik. Untuk berkas `public/`, backup ke `/tmp/`.
- **Commit TANPA trailer `Co-Authored-By`.** Aturan permanen repo ini.
- **PHP backend langsung live saat disimpan** — DocumentRoot Apache adalah `/var/www/html/bukutamu/backend`. Jalankan `php7.4 -l` segera setelah menyimpan; kalau error, pulihkan dari `.backup` saat itu juga.
- **`npm run build` BUKAN perintah baca-saja.** Vite mengosongkan `dist/` yang sedang dilayani PM2. Selalu build ke `dist-staging` lalu salin atomik — prosedurnya ada di Task 6.
- **Palet grafik SUDAH divalidasi, jangan diubah tanpa menjalankan ulang validator.** Palet grup layanan: `#c4570a` (SKD), `#0d9499` (DTSEN), `#be185d` (Resepsionis), `#2563eb` (Online) — lolos semua pemeriksaan terhadap permukaan `#ffffff`.
- **Shell admin TIDAK punya mode gelap.** Token `--admin-*` didefinisikan inline di `AdminLayout.tsx:29-45` tanpa varian `.dark`. Jangan menambahkan gaya mode gelap.
- Pakai token yang sudah ada: `--admin-primary`, `--admin-secondary`, `--admin-text`, `--admin-text-secondary`, `--admin-text-muted`, `--admin-border`, `--admin-surface`, `--admin-radius`, kelas `admin-card`.

---

## Keputusan yang BERUBAH dari spec

Ditemukan saat menyiapkan rencana, dengan menjalankan validator palet. Spec tetap berlaku kecuali tiga hal ini:

| Spec | Diganti jadi | Alasan |
| --- | --- | --- |
| D5: peta warna 6 → 9 layanan | **Warnai per GRUP layanan (4 warna)** | 9 hue kategorikal melewati batas aman. Aplikasi ini sudah punya taksonomi 4 grup, dan judul event tetap menyebut nama layanan persisnya. |
| Batang komposisi berwarna per layanan | **Satu hue (magnitudo)** | Label berdiri tepat di samping batang, jadi identitas dibawa teks. Warna berbeda-beda di situ dekoratif, bukan fungsional. |
| — | **Tambahkan hover tooltip** | Grafik SVG di halaman web bersifat interaktif secara default; tanpa tooltip, nilai per titik tidak bisa dibaca. |

Palet lama (`#0D9488,#3B82F6,#F59E0B,#8B5CF6,#EF4444,#6B7280`) **gagal validasi**: `#6B7280` di bawah lantai chroma (terbaca abu-abu) dan `#F59E0B` hanya 2.09:1 terhadap putih. Keduanya hilang dengan pindah ke palet grup.

---

### Task 1: Backend — `Dashboard::events()`

**Files:**
- Modify: `backend/application/modules/api/controllers/Dashboard.php:98-130`

**Interfaces:**
- Produces: `GET /api/dashboard/events?date_from&date_to` → tiap event kini punya `count` (int) dan `layanan` (string) selain `id`/`title`/`start`/`color`.

- [ ] **Step 1: Backup dan catat angka acuan**

```bash
cd /var/www/html/bukutamu/backend/application/modules/api/controllers
cp Dashboard.php Dashboard.php.backup
mysql db_tamdes -t -e "SELECT COUNT(*) AS total_semua FROM tamdes_kunjungan;"
```

Catat angkanya — Task 6 memakainya untuk membuktikan jumlah `count` seluruh event sama dengan total kunjungan.

- [ ] **Step 2: Ganti isi `events()`**

Ganti seluruh method `events()` dengan:

```php
    public function events() {
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }
        $this->require_auth();

        // Hormati rentang yang sama seperti stats(). Sebelumnya events() selalu
        // memuat SELURUH riwayat, sehingga sorotan dan grafik di halaman yang sama
        // bercerita tentang rentang berbeda tanpa memberi tahu siapa pun.
        $date_from = $this->input->get('date_from');
        $date_to   = $this->input->get('date_to');

        $this->db->select('DATE(date_visit) as date, COUNT(*) as count, jenis_layanan')
            ->group_by('DATE(date_visit), jenis_layanan')
            ->order_by('date', 'ASC');
        if ($date_from) { $this->db->where('DATE(date_visit) >=', $date_from); }
        if ($date_to)   { $this->db->where('DATE(date_visit) <=', $date_to); }
        $rows = $this->db->get('tamdes_kunjungan')->result();

        $events = array_map(function ($row) {
            $layanan = $this->first_layanan_name($row->jenis_layanan);
            return [
                'id'      => $row->date . '-' . $layanan,
                'title'   => $layanan . ' (' . $row->count . ')',
                'start'   => $row->date,
                'color'   => $this->warna_grup_layanan($layanan),
                // Dua field di bawah dipakai grafik dashboard. FullCalendar menyerap
                // kunci tak dikenal ke extendedProps dan mengabaikannya, jadi kalender
                // tidak terpengaruh. Mengurai angka dari `title` ("Perpustakaan (3)")
                // akan diam-diam salah begitu labelnya berubah.
                'count'   => (int) $row->count,
                'layanan' => $layanan,
            ];
        }, $rows);

        $this->json_response(['success' => true, 'data' => $events, 'message' => 'OK']);
    }

    /**
     * `jenis_layanan` tersimpan dalam DUA format: string polos ("Perpustakaan")
     * dan JSON array ('["Perpustakaan","Konsultasi Statistik"]'). Ambil nama
     * pertama supaya event punya satu label yang bisa diwarnai.
     */
    private function first_layanan_name($raw) {
        $raw = trim((string) $raw);
        if ($raw === '') { return 'Tidak diketahui'; }
        if (substr($raw, 0, 1) === '[') {
            $decoded = json_decode($raw, true);
            if (is_array($decoded) && count($decoded) > 0) {
                return (string) $decoded[0];
            }
        }
        return $raw;
    }

    /**
     * Warna per GRUP layanan, bukan per layanan. Peta lama memuat 6 layanan
     * padahal taksonominya 9, sehingga DTSEN, Daftar Antrian Offline, dan
     * Lainnya Online semuanya jatuh ke abu-abu dan tak terbedakan.
     *
     * Empat warna ini SUDAH divalidasi terhadap permukaan #ffffff — lolos
     * lantai chroma, pita lightness, pemisahan buta warna, dan kontras.
     * Jangan diubah tanpa menjalankan ulang validator palet.
     */
    private function warna_grup_layanan($layanan) {
        $skd = ['Perpustakaan', 'Konsultasi Statistik', 'Rekomendasi Kegiatan Statistik', 'Penjualan Produk Statistik'];
        $res = ['Lainnya', 'Keperluan Pimpinan', 'Daftar Antrian Offline'];

        if (in_array($layanan, $skd, true))          { return '#c4570a'; }
        if ($layanan === 'Konsultasi DTSEN')          { return '#0d9499'; }
        if (in_array($layanan, $res, true))           { return '#be185d'; }
        if ($layanan === 'Lainnya Online')            { return '#2563eb'; }
        return '#7a7068'; // di luar taksonomi — sengaja netral, bukan warna kategori
    }
```

- [ ] **Step 3: Verifikasi**

```bash
cd /var/www/html/bukutamu/backend/application/modules/api/controllers
diff Dashboard.php.backup Dashboard.php
php7.4 -l Dashboard.php
curl -sS -o /dev/null -w "auth=%{http_code} events=" http://127.0.0.1:60/api/auth/check
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:60/api/dashboard/events
```

Harapkan `No syntax errors`, `auth=401 events=401`. Method `stats()` **tidak boleh** muncul di diff. 5xx = pulihkan dari `.backup` segera.

- [ ] **Step 4: Commit**

```bash
cd /var/www/html/bukutamu
git add backend/application/modules/api/controllers/Dashboard.php
git commit -m "feat(dashboard): events() bawa count + layanan, warna per grup, hormati filter

Grafik dashboard butuh angka aslinya; mengurai dari title (\"Perpustakaan (3)\")
rapuh. FullCalendar menyerap kunci tak dikenal ke extendedProps.

Peta warna lama memuat 6 layanan padahal taksonominya 9 — DTSEN, Daftar
Antrian Offline, dan Lainnya Online jatuh ke abu-abu. Diganti warna per GRUP
(4 warna, sudah divalidasi CVD + kontras terhadap permukaan putih).

events() kini menerima date_from/date_to seperti stats(), supaya sorotan dan
grafik di halaman yang sama tidak bercerita tentang rentang berbeda."
```

---

### Task 2: Tipe, wrapper API, dan agregasi

**Files:**
- Modify: `frontend/src/types/visit.ts` (interface `CalendarEvent`)
- Modify: `frontend/src/api/dashboard.ts`
- Create: `frontend/src/lib/dashboard-aggregate.ts`

**Interfaces:**
- Consumes: field `count`/`layanan` dari Task 1
- Produces:
  - `agregatTren(events: CalendarEvent[]): { label: string; value: number }[]`
  - `agregatLayanan(events: CalendarEvent[]): { label: string; value: number; pct: number }[]`
  - `satuanTren(events: CalendarEvent[]): 'hari' | 'bulan'`

- [ ] **Step 1: Backup**

```bash
cd /var/www/html/bukutamu/frontend/src
cp types/visit.ts types/visit.ts.backup
cp api/dashboard.ts api/dashboard.ts.backup
```

- [ ] **Step 2: Tambah field ke `CalendarEvent`**

Di `types/visit.ts`, ganti interface `CalendarEvent`:

```ts
export interface CalendarEvent {
  id: string
  title: string
  start: string
  end?: string
  color: string
  /** Jumlah kunjungan pada tanggal + layanan ini. Dikirim Dashboard::events(). */
  count: number
  /** Nama layanan tunggal (elemen pertama bila tersimpan sebagai JSON array). */
  layanan: string
}
```

- [ ] **Step 3: `events()` terima rentang**

Di `api/dashboard.ts`, ganti baris `events`:

```ts
  events: (params?: { date_from?: string; date_to?: string }) =>
    apiClient.get<ApiResponse<CalendarEvent[]>>('/api/dashboard/events', { params }),
```

- [ ] **Step 4: Buat modul agregasi**

Buat `frontend/src/lib/dashboard-aggregate.ts`:

```ts
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
```

- [ ] **Step 5: Buktikan agregasi dengan data nyata**

Repo ini tidak punya kerangka tes, tapi fungsi ini murni sehingga bisa diperiksa
langsung. Dijalankan lewat **`jiti`** — sudah terpasang sebagai dependensi Vite,
memuat TypeScript berikut alias `@` tanpa instalasi apa pun. Sudah diuji bekerja;
`tsx` dan `esbuild` TIDAK tersedia di repo ini, jangan mencobanya.

Berkas pelarinya **harus** berada di dalam `frontend/` agar Node menemukan
`jiti` di `node_modules`. Keduanya dihapus di akhir langkah.

```bash
cd /var/www/html/bukutamu/frontend
cat > /tmp/cek-agregat.ts <<'EOF'
import { agregatTren, agregatLayanan, satuanTren } from '@/lib/dashboard-aggregate'
import type { CalendarEvent } from '@/types/visit'

const ev = [
  { id: 'a', title: '', start: '2026-07-01', color: '', count: 2, layanan: 'Perpustakaan' },
  { id: 'b', title: '', start: '2026-07-01', color: '', count: 3, layanan: 'Konsultasi Statistik' },
  { id: 'c', title: '', start: '2026-07-02', color: '', count: 1, layanan: 'Perpustakaan' },
] as CalendarEvent[]

const tren = agregatTren(ev)
const lay  = agregatLayanan(ev)
const total = tren.reduce((t, d) => t + d.value, 0)

const cek = [
  ['satuan harian untuk rentang 1 hari', satuanTren(ev) === 'hari'],
  ['2 titik tren (2 tanggal berbeda)',   tren.length === 2],
  ['titik pertama bernilai 5 (2+3)',     tren[0].value === 5],
  ['total tren 6',                       total === 6],
  ['3 layanan? tidak — hanya 2',         lay.length === 2],
  ['Perpustakaan teratas dgn 3',         lay[0].label === 'Perpustakaan' && lay[0].value === 3],
  ['persentase berjumlah 100',           Math.round(lay.reduce((t, l) => t + l.pct, 0)) === 100],
]
let gagal = 0
for (const [nama, lulus] of cek) {
  console.log(`${lulus ? 'OK  ' : 'GAGAL'} ${nama}`)
  if (!lulus) gagal++
}
process.exit(gagal === 0 ? 0 : 1)
EOF

cat > jalankan-cek.mjs <<'EOF'
import { createJiti } from 'jiti'
const jiti = createJiti(import.meta.url, { alias: { '@': new URL('./src', import.meta.url).pathname } })
await jiti.import('/tmp/cek-agregat.ts')
EOF

node jalankan-cek.mjs
rm -f jalankan-cek.mjs /tmp/cek-agregat.ts
```

Semua baris harus `OK`. Satu `GAGAL` berarti agregasi salah — hentikan dan
perbaiki sebelum merender apa pun di atasnya. Hapus `jalankan-cek.mjs` setelah
selesai supaya tidak ikut ter-commit.

- [ ] **Step 6: Verifikasi diff + tipe**

```bash
cd /var/www/html/bukutamu/frontend
diff src/types/visit.ts.backup src/types/visit.ts
diff src/api/dashboard.ts.backup src/api/dashboard.ts
npx tsc -b 2>&1 | tail -3
```

`tsc` harus bersih. Jangan commit dulu — Task 3-5 melengkapinya.

---

### Task 3: `TrendChart` — area SVG dengan hover

**Files:**
- Create: `frontend/src/components/admin/TrendChart.tsx`

**Interfaces:**
- Produces: `<TrendChart data={{label,value}[]} satuan="hari"|"bulan" />`

- [ ] **Step 1: Buat komponen**

```tsx
import { useState, type MouseEvent } from 'react'

interface Titik { label: string; value: number }

interface TrendChartProps {
  data: Titik[]
  satuan: 'hari' | 'bulan'
}

const W = 640
const H = 200
const PAD = { atas: 16, kanan: 12, bawah: 26, kiri: 12 }

export function TrendChart({ data, satuan }: TrendChartProps) {
  const [aktif, setAktif] = useState<number | null>(null)

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[200px] text-sm" style={{ color: 'var(--admin-text-muted)' }}>
        Belum ada data pada rentang ini
      </div>
    )
  }

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
    <div className="relative">
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
```

- [ ] **Step 2: Type-check**

```bash
cd /var/www/html/bukutamu/frontend && npx tsc -b 2>&1 | tail -3
```

Harus bersih.

---

### Task 4: `ServiceBars` dan `MiniStat`

**Files:**
- Create: `frontend/src/components/admin/ServiceBars.tsx`
- Create: `frontend/src/components/admin/MiniStat.tsx`

**Interfaces:**
- Produces: `<ServiceBars data={{label,value,pct}[]} />`, `<MiniStat label value />`

- [ ] **Step 1: `ServiceBars.tsx`**

```tsx
interface Baris { label: string; value: number; pct: number }

interface ServiceBarsProps {
  data: Baris[]
}

/**
 * Batang horizontal SATU HUE. Identitas dibawa label yang berdiri tepat di
 * samping batangnya, jadi warna berbeda-beda per layanan hanya dekoratif —
 * dan sembilan hue kategorikal melewati batas aman keterbacaan buta warna.
 * Satu hue membuat panjang batang jadi satu-satunya isyarat, yang memang
 * pekerjaannya: membandingkan besaran.
 */
export function ServiceBars({ data }: ServiceBarsProps) {
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
```

- [ ] **Step 2: `MiniStat.tsx`**

```tsx
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
```

- [ ] **Step 3: Type-check**

```bash
cd /var/www/html/bukutamu/frontend && npx tsc -b 2>&1 | tail -3
```

---

### Task 5: `DashboardPage` — tata letak empat lapis

**Files:**
- Modify: `frontend/src/pages/admin/DashboardPage.tsx` (tulis ulang bagian render)

**Interfaces:**
- Consumes: semuanya dari Task 2-4.

- [ ] **Step 1: Backup**

```bash
cd /var/www/html/bukutamu/frontend/src/pages/admin
cp DashboardPage.tsx DashboardPage.tsx.backup
```

- [ ] **Step 2: Perbarui impor**

Ganti blok impor teratas dengan:

```tsx
import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import { dashboardApi } from '@/api/dashboard'
import { StatsCard } from '@/components/admin/StatsCard'
import { TrendChart } from '@/components/admin/TrendChart'
import { ServiceBars } from '@/components/admin/ServiceBars'
import { MiniStat } from '@/components/admin/MiniStat'
import { agregatTren, agregatLayanan, satuanTren } from '@/lib/dashboard-aggregate'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Users, User, CheckCircle, BarChart3 } from 'lucide-react'
```

- [ ] **Step 3: `events` ikut difilter, tambah agregasi**

Ganti query `events` dan `statsItems` dengan:

```tsx
  const { data: events, isLoading: eventsLoading } = useQuery({
    queryKey: ['dashboard-events', filterParams],
    queryFn: () => dashboardApi.events(filterParams).then(r => r.data.data),
  })

  const tren = useMemo(() => agregatTren(events ?? []), [events])
  const satuan = useMemo(() => satuanTren(events ?? []), [events])
  const layanan = useMemo(() => agregatLayanan(events ?? []), [events])

  const sorotan = stats
    ? [
        { label: 'Total Kunjungan', value: stats.total_kunjungan, icon: <Users className="w-5 h-5" /> },
        { label: 'Tamu Unik', value: stats.tamu_unik, icon: <User className="w-5 h-5" /> },
        { label: 'Tingkat Selesai', value: `${stats.tingkat_selesai}%`, icon: <CheckCircle className="w-5 h-5" /> },
        { label: 'Rata-rata/Hari', value: stats.rata_rata_per_hari, icon: <BarChart3 className="w-5 h-5" /> },
      ]
    : []

  const ringkas = stats
    ? [
        { label: 'Jumlah Hari', value: stats.jumlah_hari },
        { label: 'Hari Tersibuk', value: stats.hari_tersibuk },
        { label: 'Periode Aktif', value: stats.periode_aktif },
        { label: 'Selesai', value: stats.selesai },
        { label: 'Antri', value: stats.antri },
        { label: 'Rata-rata Durasi', value: stats.rata_rata_durasi },
        { label: 'Layanan Terbanyak', value: stats.layanan_terbanyak },
        { label: 'Instansi Terbanyak', value: stats.instansi_terbanyak },
      ]
    : []
```

- [ ] **Step 4: Ganti `StatsSkeleton`**

Skeleton lama menggambar 12 kotak seragam — bentuk yang tidak ada lagi. Ganti:

```tsx
function DashboardSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-[1.6fr_1fr] gap-5">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Ganti seluruh blok `return`**

Ganti dari `{/* Two-column: stats left, calendar right */}` sampai sebelum penutup `</div>` terluar:

```tsx
      {statsLoading ? (
        <DashboardSkeleton />
      ) : (
        <>
          {/* Lapis 1 — sorotan */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {sorotan.map(s => (
              <StatsCard key={s.label} label={s.label} value={s.value} icon={s.icon} accent="primary" />
            ))}
          </div>

          {/* Lapis 2 — grafik */}
          <div className="grid grid-cols-1 xl:grid-cols-[1.6fr_1fr] gap-5">
            <div className="admin-card p-5">
              <h2 className="text-sm font-bold mb-1" style={{ color: 'var(--admin-text)' }}>Tren Kunjungan</h2>
              <p className="text-xs mb-3" style={{ color: 'var(--admin-text-muted)' }}>
                Jumlah kunjungan per {satuan}
              </p>
              {eventsLoading ? <Skeleton className="h-[200px] rounded-xl" /> : <TrendChart data={tren} satuan={satuan} />}
            </div>
            <div className="admin-card p-5">
              <h2 className="text-sm font-bold mb-1" style={{ color: 'var(--admin-text)' }}>Komposisi Layanan</h2>
              <p className="text-xs mb-3" style={{ color: 'var(--admin-text-muted)' }}>
                Bagian tiap layanan dari total
              </p>
              {eventsLoading ? <Skeleton className="h-[200px] rounded-xl" /> : <ServiceBars data={layanan} />}
            </div>
          </div>

          {/* Lapis 3 — ringkas */}
          <div className="admin-card p-5">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-4">
              {ringkas.map(r => <MiniStat key={r.label} label={r.label} value={r.value} />)}
            </div>
          </div>
        </>
      )}

      {/* Lapis 4 — kalender lebar penuh */}
      <div className="admin-card p-5">
        <h2 className="text-sm font-bold mb-3" style={{ color: 'var(--admin-text)' }}>Kalender Kunjungan</h2>
        {eventsLoading ? (
          <Skeleton className="h-64 rounded-xl" />
        ) : (
          <FullCalendar
            plugins={[dayGridPlugin]}
            initialView="dayGridMonth"
            events={events ?? []}
            locale="id"
            headerToolbar={{ left: 'prev,next today', center: 'title', right: '' }}
            height="auto"
          />
        )}
      </div>
```

- [ ] **Step 6: Lint, type-check, dan verifikasi diff**

```bash
cd /var/www/html/bukutamu/frontend
npm run lint 2>&1 | tail -3
npx tsc -b 2>&1 | tail -3
diff src/pages/admin/DashboardPage.tsx.backup src/pages/admin/DashboardPage.tsx | head -40
```

`npm run lint` harus **0 error**. Kalau ada impor yang tak terpakai (mis. ikon lama seperti `Flame`, `Trophy`), hapus dari baris impor.

- [ ] **Step 7: Commit Task 2-5 bersama**

```bash
cd /var/www/html/bukutamu
git add frontend/src/types/visit.ts \
        frontend/src/api/dashboard.ts \
        frontend/src/lib/dashboard-aggregate.ts \
        frontend/src/components/admin/TrendChart.tsx \
        frontend/src/components/admin/ServiceBars.tsx \
        frontend/src/components/admin/MiniStat.tsx \
        frontend/src/pages/admin/DashboardPage.tsx
git commit -m "feat(dashboard): tata letak empat lapis dengan grafik SVG

12 StatsCard identik tanpa hierarki diganti: 4 sorotan besar, 2 grafik, baris
ringkas 8 statistik, kalender lebar penuh.

TrendChart area SVG dengan crosshair + tooltip; satuan otomatis harian (<=62
hari) atau bulanan. ServiceBars satu hue karena identitas dibawa label di
sampingnya, bukan warna. MiniStat menampung nilai teks panjang yang selama ini
memaksa StatsCard mengecilkan fontnya sendiri.

Agregasi jadi fungsi murni di lib/dashboard-aggregate.ts; komponen grafik hanya
menerima data jadi dan tidak tahu soal CalendarEvent."
```

---

### Task 6: Verifikasi dan rilis

**Files:**
- Modify: `frontend/public/sw.js` (bump `CACHE_NAME`)

- [ ] **Step 1: Bump service worker**

```bash
cd /var/www/html/bukutamu/frontend
cp public/sw.js /tmp/sw.js.backup     # JANGAN backup di dalam public/
grep -o "admin-bukutamu-8200-v[0-9]*" public/sw.js
```

Naikkan angkanya satu tingkat, lalu `node --check public/sw.js`.

- [ ] **Step 2: Build ke staging, JANGAN ke dist**

```bash
cd /var/www/html/bukutamu/frontend
npx tsc -b && npx vite build --outDir dist-staging
[ -f dist-staging/index.html ] && echo "staging OK: $(ls dist-staging/assets | wc -l) aset"
for a in $(grep -oE 'assets/[A-Za-z0-9._-]+\.(js|css)' dist-staging/index.html | sort -u); do
  [ -f "dist-staging/$a" ] || echo "HILANG $a"
done
```

- [ ] **Step 3: Salin atomik ke dist**

```bash
cd /var/www/html/bukutamu/frontend
for f in dist-staging/assets/*; do
  b=$(basename "$f"); cp "$f" "dist/assets/.tmp-$b" && mv -f "dist/assets/.tmp-$b" "dist/assets/$b"
done
for item in dist-staging/*; do
  b=$(basename "$item"); [ "$b" = "index.html" ] && continue; [ "$b" = "assets" ] && continue
  cp -r "$item" dist/
done
cp dist-staging/index.html dist/.tmp-index.html && mv -f dist/.tmp-index.html dist/index.html
find dist -name "*.backup" -o -name ".tmp-*" | head
```

Perintah terakhir harus tidak mengeluarkan apa pun.

- [ ] **Step 4: Smoke test**

```bash
curl -sS -o /dev/null -w "frontend=%{http_code} " http://localhost:3060/admin
curl -sS -o /dev/null -w "backend=%{http_code}\n" http://127.0.0.1:60/api/auth/check
for a in $(curl -sS https://bukutamu.bpsmalut.com/ 2>/dev/null | grep -oE 'assets/[A-Za-z0-9._-]+\.(js|css)' | sort -u); do
  C=$(curl -sS -o /dev/null -w "%{http_code}" "https://bukutamu.bpsmalut.com/$a"); [ "$C" = "200" ] || echo "GAGAL $C $a"
done
```

Harapkan `frontend=200 backend=401` dan tidak ada baris GAGAL.

- [ ] **Step 5: Bukti angka — jumlah count == total kunjungan**

Inilah yang membuktikan Task 1 dan agregasi Task 2 benar:

```bash
mysql db_tamdes -t -e "SELECT COUNT(*) AS total_kunjungan FROM tamdes_kunjungan;"
```

Bandingkan dengan jumlah seluruh `count` di respons `/api/dashboard/events` tanpa filter. Keduanya harus **sama persis**. Kalau berbeda, agregasi atau `first_layanan_name()` menjatuhkan baris — hentikan dan cari sebabnya.

- [ ] **Step 6: Walkthrough browser** *(harus manusia)*

Buka `https://bukutamu.bpsmalut.com/admin` dan periksa:

1. Empat sorotan tampil dengan angka yang masuk akal.
2. Grafik tren punya bentuk; arahkan kursor → crosshair + tooltip muncul dengan label dan angka.
3. Judul grafik menyebut "per bulan" tanpa filter; setelah memfilter rentang pendek (mis. satu minggu) berubah jadi "per hari".
4. Komposisi layanan: batang terpanjang di atas, persentase masuk akal, totalnya ~100%.
5. Baris ringkas: "Instansi Terbanyak" yang teksnya panjang **tidak** terpotong atau mengecil aneh.
6. **Kalender tetap berfungsi persis seperti sebelumnya** — event berwarna, navigasi bulan jalan.
7. Perkecil jendela sampai lebar ponsel — tidak ada yang meluber horizontal.

- [ ] **Step 7: Commit dan bersihkan**

```bash
cd /var/www/html/bukutamu
git add frontend/public/sw.js
git commit -m "chore(frontend): bump CACHE_NAME service worker untuk rilis dashboard"
```

---

## Catatan untuk pelaksana

**Palet sudah divalidasi — jangan ubah warna tanpa menjalankan ulang validator.** Empat warna grup layanan lolos lantai chroma, pita lightness, pemisahan buta warna, dan kontras terhadap permukaan putih. Palet lama gagal dua pemeriksaan; itulah yang diperbaiki.

**Tidak ada mode gelap di shell admin.** Token `--admin-*` didefinisikan inline di `AdminLayout.tsx:29-45` tanpa varian `.dark`. Jangan menambahkan gaya mode gelap yang tidak akan pernah aktif.

**Rollback.** Tiap task menyimpan `.backup` di samping berkasnya (kecuali `sw.js`, yang ke `/tmp`). Backend cukup dipulihkan berkasnya — PHP live saat disimpan. Frontend: pulihkan berkas lalu ulangi Task 6 Step 2-3.

**Tidak ada tes regresi.** Perubahan ini menyentuh endpoint yang juga memberi makan kalender. Verifikasi paling penting justru poin 6 di walkthrough: kalender harus tetap berfungsi persis seperti sebelumnya.
