# Sidebar Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kelompokkan 14 item sidebar jadi empat kelompok bermakna, seragamkan labelnya dengan judul halaman tujuan, dan beri ritme visual — tanpa menyentuh logika gerbang role sama sekali.

**Architecture:** `NAV_ITEMS` (array rata) menjadi `NAV_GROUPS` (array kelompok berisi item). Predikat penyaring role dipindahkan apa adanya ke sebuah fungsi `isVisible`, lalu diterapkan per kelompok; kelompok yang tidak menyisakan item tidak dirender. Judul kelompok memakai ulang mekanisme `.admin-side-label` yang sudah ada agar hilang otomatis di rail terciut.

**Tech Stack:** React 19 + TypeScript 5.9, `react-router-dom` 7 `NavLink`, CSS inline di `AdminLayout.tsx`, `lucide-react`.

**Spec:** `docs/superpowers/specs/2026-07-31-sidebar-rework-design.md`

## Global Constraints

- **Repo ini tidak punya tes otomatis.** Tidak ada Vitest/Jest/`npm test`. Jangan mengarang skrip tes. Verifikasi = `npm run lint`, `npx tsc -b`, pembacaan diff, dan pemeriksaan browser.
- **`npm run build` BUKAN perintah baca-saja.** Vite mengosongkan `dist/` yang sedang dilayani PM2 → 404 nyata bagi siapa pun yang memuat halaman saat itu. Selalu `npx vite build --outDir dist-staging` lalu salin atomik. Prosedurnya di Task 2.
- **Backup sebelum tiap edit:** `cp {file} {file}.backup`, lalu `diff`. **KECUALI di `frontend/public/`** — Vite menyalin direktori itu apa adanya ke `dist/` dan PM2 menerbitkannya, jadi backup di sana bisa diunduh publik. Untuk `sw.js`, backup ke `/tmp/`.
- **Commit TANPA trailer `Co-Authored-By`.** Aturan permanen repo ini.
- **LOGIKA GERBANG ROLE TIDAK BOLEH BERUBAH.** `ROLE_LEVEL`, `PST_DTSEN_ROLES`, `MUTATION_ENTRY_ROLES`, nilai `minRole`/`allowedRoles` tiap item, dan isi predikat penyaring harus identik. Ini bukan preferensi — ia yang membuat perubahan ini tidak punya permukaan keamanan.
- **Shell admin TIDAK punya mode gelap.** Token `--admin-*` didefinisikan inline di `AdminLayout.tsx:29-45` tanpa varian `.dark`. Jangan menambahkan gaya mode gelap.
- Pakai hanya token yang sudah ada: `--admin-text-muted`, `--admin-border`, `--admin-primary`, `--admin-primary-light`. Tidak ada hex hardcoded, tidak ada variabel CSS baru.
- Jangan mengubah bagian aksi bawah (lonceng, tombol PWA, nama pengguna, Keluar) maupun perilaku `onNavigate` drawer mobile.
- **Repo ini punya hook yang MEMBLOKIR `rm -f` dan `rm -rf`** (`.claude/hooks/validate-bash.sh`). Jangan memakainya sama sekali — perintahnya akan ditolak dan langkahnya gagal. Tulis berkas sementara ke direktori scratchpad sesi dan biarkan di sana.

---

### Task 1: Sidebar berkelompok + label baru + CSS

Komponen dan CSS-nya diubah dalam SATU task karena komponen memancarkan kelas yang di-styling CSS itu — mereview salah satunya sendirian berarti menilai setengah perubahan.

**Files:**
- Modify: `frontend/src/components/admin/Sidebar.tsx`
- Modify: `frontend/src/layouts/AdminLayout.tsx` (blok CSS sidebar)

**Interfaces:**
- Produces: kelas CSS baru `.admin-side-group` dan `.admin-side-grouptitle`, dikonsumsi oleh CSS di `AdminLayout.tsx`.

- [ ] **Step 1: Backup dan catat jumlah menu per role SEBELUM diubah**

```bash
cd /var/www/html/bukutamu/frontend/src
cp components/admin/Sidebar.tsx components/admin/Sidebar.tsx.backup
cp layouts/AdminLayout.tsx layouts/AdminLayout.tsx.backup
```

Angka acuan yang harus tetap sama sesudahnya:

| Role | Menu terlihat |
| --- | --- |
| superadmin | 14 |
| admin | 13 |
| pimpinan | 11 |
| operator | 8 |
| petugas_pst | 8 |
| resepsionis | 5 |
| verifikator | 1 |

- [ ] **Step 2: Ganti `NAV_ITEMS` dengan `NAV_GROUPS`**

Di `Sidebar.tsx`, ganti seluruh blok `const NAV_ITEMS: NavItem[] = [ ... ]` (baris 55-70) dengan:

```tsx
interface NavGroup {
  /** null = kelompok tanpa judul (Dashboard, si beranda). */
  title: string | null
  items: NavItem[]
}

// Label = bentuk terpendek yang tidak ambigu dari judul halaman tujuan,
// seluruhnya bahasa Indonesia. Sebelumnya hanya 4 dari 14 label cocok dengan
// judul halamannya: "PST" -> "Antrian PST — Semua Tanggal", "Users" ->
// "Manajemen User". Nilai `minRole` dan `allowedRoles` TIDAK diubah satu pun.
const NAV_GROUPS: NavGroup[] = [
  {
    title: null,
    items: [
      { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true, minRole: 'operator' },
    ],
  },
  {
    title: 'Pelayanan',
    items: [
      { to: '/admin/consultations', label: 'Antrian PST', icon: ClipboardList, minRole: 'operator', allowedRoles: PST_DTSEN_ROLES },
      { to: '/admin/dtsen', label: 'Antrian DTSEN', icon: Database, minRole: 'operator', allowedRoles: PST_DTSEN_ROLES },
      { to: '/admin/layanan-online', label: 'Layanan Online', icon: MessageSquare, minRole: 'operator', allowedRoles: PST_DTSEN_ROLES },
      { to: '/admin/verifikasi', label: 'Verifikasi Data', icon: BadgeCheck, minRole: 'operator', allowedRoles: ['verifikator', 'admin', 'superadmin'] },
    ],
  },
  {
    title: 'Data Kunjungan',
    items: [
      { to: '/admin/guests', label: 'Daftar Tamu', icon: Users, minRole: 'operator' },
      { to: '/admin/visits', label: 'Daftar Kunjungan', icon: FileText, minRole: 'operator' },
      { to: '/admin/manual-entry', label: 'Tambah Kunjungan', icon: PlusCircle, minRole: 'operator', allowedRoles: MUTATION_ENTRY_ROLES },
    ],
  },
  {
    title: 'Laporan',
    items: [
      { to: '/admin/evaluations', label: 'Hasil Evaluasi', icon: Star, minRole: 'admin' },
      { to: '/admin/responden', label: 'Responden SKD', icon: CalendarDays, minRole: 'admin' },
      { to: '/admin/queue-stats', label: 'Analisis Antrian', icon: BarChart3, minRole: 'admin' },
    ],
  },
  {
    title: 'Sistem',
    items: [
      { to: '/admin/users', label: 'Manajemen Pengguna', icon: UserCog, minRole: 'superadmin' },
      { to: '/admin/audit', label: 'Log Audit', icon: Shield, minRole: 'admin' },
      { to: '/admin/tentang', label: 'Tentang', icon: Info, minRole: 'operator' },
    ],
  },
]
```

- [ ] **Step 3: Ekstrak predikat penyaring APA ADANYA, terapkan per kelompok**

Ganti blok `const visibleItems = NAV_ITEMS.filter(...)` (baris 87-92) dengan:

```tsx
  // Isi predikat ini SALIN PERSIS dari versi sebelumnya — tidak satu baris pun
  // berubah. Yang berubah hanya tempatnya: dari filter atas array rata menjadi
  // fungsi yang diterapkan per kelompok. Ini yang membuat perubahan tampilan
  // tidak menyentuh siapa-melihat-apa.
  const isVisible = (item: NavItem) => {
    // verifikator sees ONLY items that explicitly list 'verifikator' in allowedRoles
    if (userRole === 'verifikator') return item.allowedRoles?.includes('verifikator') ?? false
    if (item.allowedRoles && !item.allowedRoles.includes(userRole)) return false
    return userLevel >= ROLE_LEVEL[item.minRole]
  }

  // Kelompok yang tidak menyisakan item dibuang BESERTA judulnya. Wajib, bukan
  // pemanis: resepsionis tidak punya satu pun item Pelayanan maupun Laporan, dan
  // verifikator hanya punya satu item di seluruh sidebar — tanpa ini mereka
  // melihat judul kelompok yang menggantung tanpa isi.
  const visibleGroups = NAV_GROUPS
    .map((group) => ({ ...group, items: group.items.filter(isVisible) }))
    .filter((group) => group.items.length > 0)
```

- [ ] **Step 4: Render berkelompok**

Ganti isi `<nav className="admin-sidebar-nav">` (baris 120-137) dengan:

```tsx
      <nav className="admin-sidebar-nav">
        {visibleGroups.map((group, gi) => (
          <div key={group.title ?? `grup-${gi}`} className="admin-side-group">
            {group.title && (
              // Teks judul dibungkus .admin-side-label — kelas yang SUDAH
              // disembunyikan oleh aturan `.admin-shell.is-collapsed`. Jadi di rail
              // terciut teksnya hilang sendiri dan elemen <p>-nya tinggal jadi
              // garis pemisah, tanpa mekanisme baru.
              <p className="admin-side-grouptitle">
                <span className="admin-side-label">{group.title}</span>
              </p>
            )}
            {group.items.map((item) => {
              const Icon = item.icon
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={onNavigate}
                  title={collapsed ? item.label : undefined}
                  className={({ isActive }) => cn('admin-side-item', isActive && 'admin-side-active')}
                >
                  <Icon className="w-[18px] h-[18px] shrink-0" />
                  <span className="admin-side-label">{item.label}</span>
                </NavLink>
              )
            })}
          </div>
        ))}
      </nav>
```

- [ ] **Step 5: Tambah CSS kelompok**

Di `AdminLayout.tsx`, tepat SETELAH aturan `.admin-sidebar-nav { ... }`, sisipkan:

```css
        .admin-side-group {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        /* Jeda antar-kelompok harus jelas lebih besar daripada jeda antar-item
           (2px), kalau tidak kelompoknya tidak terbaca sebagai kelompok. */
        .admin-side-group + .admin-side-group { margin-top: 14px; }
        .admin-side-grouptitle {
          margin: 0;
          padding: 0 11px 5px;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: var(--admin-text-muted);
        }
```

- [ ] **Step 6: Tambah aturan rail terciut**

Di blok `/* Collapsed (desktop icon rail) */`, tambahkan setelah aturan `.admin-side-item` yang sudah ada:

```css
        /* Judul kelompok jadi garis pemisah: teksnya sudah disembunyikan oleh
           aturan .admin-side-label di atas, elemen <p>-nya tinggal diubah jadi
           garis 1px supaya ritme kelompok tetap terasa saat hanya ikon tampak. */
        .admin-shell.is-collapsed .admin-side-grouptitle {
          height: 1px;
          padding: 0;
          margin: 8px 10px;
          background: var(--admin-border);
        }
```

- [ ] **Step 7: Buktikan gerbang role tidak berubah**

Tiga pemeriksaan yang bersama-sama membuktikannya, tanpa perlu menjalankan aplikasi:

```bash
cd /var/www/html/bukutamu/frontend/src/components/admin

echo "=== 1. Himpunan rute harus IDENTIK (14 rute, sama persis) ==="
diff <(grep -oE "to: '[^']+'" Sidebar.tsx.backup | sort) \
     <(grep -oE "to: '[^']+'" Sidebar.tsx | sort) && echo "IDENTIK"

echo "=== 2. Pasangan minRole/allowedRoles tiap rute harus IDENTIK ==="
diff <(grep -oE "to: '[^']+'.*" Sidebar.tsx.backup | sed -E "s/label: '[^']*', //; s/icon: [A-Za-z]+, //" | sort) \
     <(grep -oE "to: '[^']+'.*" Sidebar.tsx | sed -E "s/label: '[^']*', //; s/icon: [A-Za-z]+, //" | sort) \
  && echo "IDENTIK"

echo "=== 3. Isi predikat harus IDENTIK ==="
diff <(grep -A3 "verifikator sees ONLY" Sidebar.tsx.backup) \
     <(grep -A3 "verifikator sees ONLY" Sidebar.tsx) && echo "IDENTIK"
```

Ketiganya harus mencetak `IDENTIK`. Kalau pemeriksaan 1 atau 2 gagal, sebuah item hilang, bertambah, atau gerbangnya bergeser — hentikan dan perbaiki. Kalau 3 gagal, predikatnya tidak disalin apa adanya.

Lalu hitung ulang jumlah per role dari struktur BARU dan bandingkan dengan tabel di Step 1:

Regex di bawah SUDAH diuji terhadap struktur `NAV_GROUPS` yang baru — ia mengurai
ketiga bentuk `allowedRoles` (konstanta `PST_DTSEN_ROLES`, konstanta
`MUTATION_ENTRY_ROLES`, dan array literal) serta item tanpa `allowedRoles`.

```bash
cd /var/www/html/bukutamu/frontend
cat > cek-nav.mjs <<'EOF'
import { readFileSync } from 'node:fs'
const src = readFileSync('src/components/admin/Sidebar.tsx', 'utf8')
const LEVEL = { operator:1, resepsionis:1, petugas_pst:1, verifikator:1, pimpinan:2, admin:2, superadmin:3 }
const PST = ['petugas_pst','operator','admin','superadmin','pimpinan']
const MUT = ['operator','admin','superadmin','petugas_pst','resepsionis']
const items = [...src.matchAll(/\{ to: '([^']+)'.*?minRole: '(\w+)'(?:, allowedRoles: (PST_DTSEN_ROLES|MUTATION_ENTRY_ROLES|\[[^\]]*\]))? \}/g)]
  .map(m => ({ to: m[1], min: m[2],
    allowed: m[3] === 'PST_DTSEN_ROLES' ? PST
           : m[3] === 'MUTATION_ENTRY_ROLES' ? MUT
           : m[3] ? JSON.parse(m[3].replace(/'/g, '"')) : undefined }))
console.log(`  item terbaca: ${items.length} (harus 14)`)
const HARAP = { superadmin:14, admin:13, pimpinan:11, operator:8, petugas_pst:8, resepsionis:5, verifikator:1 }
let gagal = 0
for (const [role, harap] of Object.entries(HARAP)) {
  const n = items.filter(i => {
    if (role === 'verifikator') return i.allowed?.includes('verifikator') ?? false
    if (i.allowed && !i.allowed.includes(role)) return false
    return LEVEL[role] >= LEVEL[i.min]
  }).length
  const ok = n === harap
  if (!ok) gagal++
  console.log(`  ${ok ? 'OK   ' : 'GAGAL'} ${role.padEnd(13)} ${n} (harap ${harap})`)
}
process.exit(gagal === 0 && items.length === 14 ? 0 : 1)
EOF
node cek-nav.mjs
git status --short frontend/cek-nav.mjs   # pastikan tidak ikut ter-commit
```

Semua baris harus `OK` dan item terbaca harus 14. Berkas `cek-nav.mjs` dibuat di
`frontend/` supaya Node menemukan modul intinya; **jangan `rm`** (hook repo
memblokirnya) — cukup pastikan ia tidak ikut di-`git add` pada Step 9.

- [ ] **Step 8: Lint, type-check, diff**

```bash
cd /var/www/html/bukutamu/frontend
npm run lint 2>&1 | tail -3
npx tsc -b 2>&1 | tail -3
diff src/components/admin/Sidebar.tsx.backup src/components/admin/Sidebar.tsx
diff src/layouts/AdminLayout.tsx.backup src/layouts/AdminLayout.tsx
```

`npm run lint` harus **0 error**. Diff `AdminLayout.tsx` harus hanya berisi dua blok CSS tambahan — tidak ada aturan lama yang berubah.

- [ ] **Step 9: Commit**

```bash
cd /var/www/html/bukutamu
git add frontend/src/components/admin/Sidebar.tsx frontend/src/layouts/AdminLayout.tsx
git commit -m "feat(admin): sidebar berkelompok dengan label yang menepati halamannya

14 item dalam satu daftar rata dipecah jadi empat kelompok (Pelayanan, Data
Kunjungan, Laporan, Sistem) dengan Dashboard berdiri sendiri sebagai beranda.

Label diseragamkan: bentuk terpendek yang tidak ambigu dari judul halaman
tujuan, seluruhnya Indonesia. Sebelumnya hanya 4 dari 14 yang cocok — mengklik
\"PST\" mendarat di \"Antrian PST\", mengklik \"Users\" mendarat di \"Manajemen
User\". \"Users\" juga satu-satunya label Inggris di seluruh sidebar.

Kelompok tanpa item terlihat dibuang beserta judulnya; wajib karena resepsionis
tidak punya satu pun item Pelayanan/Laporan dan verifikator hanya punya satu
item. Judul kelompok memakai ulang .admin-side-label sehingga di rail terciut
teksnya hilang sendiri dan elemennya tinggal jadi garis pemisah.

Logika gerbang role TIDAK disentuh — predikat disalin apa adanya, nilai
minRole/allowedRoles tiap item tidak berubah. Terverifikasi: jumlah menu per
role tetap 14/13/11/8/8/5/1."
```

---

### Task 2: Verifikasi dan rilis

**Files:**
- Modify: `frontend/public/sw.js` (bump `CACHE_NAME`)

- [ ] **Step 1: Bump service worker**

```bash
cd /var/www/html/bukutamu/frontend
cp public/sw.js /tmp/sw.js.backup     # JANGAN backup di dalam public/
```

Di `public/sw.js` baris 11, ubah `admin-bukutamu-8200-v75` menjadi
`admin-bukutamu-8200-v76` (nilai saat ini sudah diperiksa: **v75**). Lalu:

```bash
node --check public/sw.js
diff /tmp/sw.js.backup public/sw.js
```

Diff harus tepat satu baris.

- [ ] **Step 2: Build ke staging**

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

Harapkan `frontend=200 backend=401` dan tidak ada baris GAGAL. Jangan memakai
`https://bukutamu.bpsmalut.com:460/...` — hostname itu hanya beresolusi ke IP
Cloudflare yang tidak melayani port 460, jadi curl menggantung ~270 detik lalu gagal.

- [ ] **Step 5: Walkthrough browser** *(harus manusia)*

Buka `https://bukutamu.bpsmalut.com/admin` dan periksa:

1. Empat judul kelompok tampil, jaraknya jelas lebih lega daripada jarak antar-item.
2. Tiap tautan mendarat di halaman yang judulnya sesuai labelnya.
3. Ciutkan sidebar → judul kelompok berubah jadi garis tipis, ikon tidak bergeser.
4. Lebarkan lagi → judul kembali, tidak ada yang melompat.
5. Perkecil sampai lebar ponsel → drawer masih menutup otomatis saat tautan ditekan.
6. `Manajemen Pengguna` (label terpanjang) tidak terpotong di sidebar 240px.
7. Kalau bisa, masuk sebagai `resepsionis` — hanya Dashboard, Data Kunjungan, dan
   Sistem yang tampil; **tidak ada judul kelompok kosong menggantung**.

- [ ] **Step 6: Commit**

```bash
cd /var/www/html/bukutamu
git add frontend/public/sw.js
git commit -m "chore(frontend): bump CACHE_NAME service worker untuk rilis sidebar"
```

---

## Catatan untuk pelaksana

**Gerbang role adalah garis merah.** Step 7 di Task 1 bukan formalitas — tiga diff itu yang membuktikan perubahan tampilan ini tidak menyentuh siapa-melihat-apa. Kalau salah satunya tidak mencetak `IDENTIK`, sesuatu bergeser dan harus dicari sebabnya sebelum lanjut.

**Utang yang SENGAJA tidak dikerjakan** (ada di §8 spec): 9 dari 14 item membawa `minRole` yang tidak pernah mengecualikan siapa pun, `allowedRoles` selalu menimpa `minRole` di mana keduanya ada, dan ada kasus khusus `verifikator` di-hardcode. Semuanya nyata — dan justru karena itu ia butuh spec serta verifikasi tujuh-role sendiri, bukan ditumpangkan ke pekerjaan kosmetik.

**Rollback.** `.backup` tersimpan di samping tiap berkas (kecuali `sw.js`, di `/tmp`). Pulihkan berkas lalu ulangi Task 2 Step 2-3.
