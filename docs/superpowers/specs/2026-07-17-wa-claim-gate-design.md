# Gerbang Wajib-Klaim — Layanan Online (WhatsApp)

- **Tanggal:** 2026-07-17
- **Status:** Disetujui, siap direncanakan
- **Halaman terdampak:** `/admin/layanan-online`
- **Berkas inti:** `backend/application/modules/api/controllers/Wa.php`,
  `frontend/src/pages/admin/LayananOnlineInboxPage.tsx`,
  `frontend/src/components/wa/ChatPopup.tsx`

## 1. Masalah

Mesin "Ambil alih" sudah ada sejak audit `#17` (migrasi
`docs/migrations/2026-06-11-wa-takeover-manual-close.sql`): kolom
`wa_sessions.assigned_to` / `assigned_at`, endpoint klaim atomik
`POST /api/wa/sessions/{id}/assign`, dan tombol "Ambil alih" di inbox.

Namun **kebijakannya fail-open**. Di `Wa.php:1558`:

```php
private function wa_require_session_owner($sess) {
    if (!$sess) return;
    $assigned = (int) ($sess->assigned_to ?? 0);
    if ($assigned === 0) return;          // ← sesi belum diklaim = bebas ditulis siapa pun
    ...
}
```

Komentar di atasnya menyatakan maksud itu secara eksplisit: *"Unclaimed sessions
(or a null session) stay open to any write-role operator."*

Artinya klaim hari ini hanya **mencegah tabrakan** (sesi yang sudah dipegang
terkunci dari orang lain), bukan **mewajibkan kepemilikan**. Petugas bisa
memproses dan membalas chat tanpa pernah mengklaim — sehingga penanganan tak
punya pemilik tercatat, dan pemohon tak pernah menerima pesan "sedang ditangani
oleh".

Selain itu tiga endpoint tak pernah dipagari sama sekali:

| Aksi | Endpoint | Guard hari ini |
| --- | --- | --- |
| Balas teks | `POST /api/wa/messages` | ada, tapi lolos bila belum diklaim |
| Kirim media | `POST /api/wa/messages/upload` | ada, tapi lolos bila belum diklaim |
| Reaksi emoji | `POST /api/wa/react` | ada, tapi lolos bila belum diklaim |
| Proses | `POST /api/wa/visits/{id}/proses` | **tidak ada** |
| Selesai | `POST /api/wa/visits/{id}/selesai` | **tidak ada** |
| Kirim Form Data | `POST /api/wa/sessions/{id}/send-data-form` | **tidak ada** |

## 2. Tujuan

Petugas **wajib mengambil alih dulu** sebelum dapat memproses, menutup, atau
mengirim apa pun ke pemohon. Membaca tetap terbuka. Admin menjadi pengawas
murni: melihat semua, boleh bertindak, tapi tak pernah memiliki sesi.

## 3. Keputusan yang diambil

| # | Keputusan | Alasan |
| --- | --- | --- |
| D1 | **Tolak keras**, bukan klaim-otomatis | Klaim harus tindakan sadar. Pesan "sedang ditangani oleh X" terkirim tepat saat petugas benar-benar berkomitmen, bukan sebagai efek samping tersembunyi. |
| D2 | **Baca tetap terbuka**, hanya kirim yang dikunci | Peran `pimpinan` sengaja read-only (`wa_can_write()` mengecualikannya) — mengunci baca akan membutakannya. Petugas juga perlu membaca konteks sebelum memutuskan mengambil. |
| D3 | **Admin bebas bertindak tanpa klaim** | Mempertahankan perilaku admin hari ini. Bukan kemunduran; perubahan ini murni memperketat petugas. |
| D4 | **Admin tak bisa klaim**, tapi bisa **Lepaskan** | Admin = pengawas, bukan pemilik. "Lepaskan" adalah katup pengaman: tanpa itu, sesi milik petugas yang resign/sakit terkunci selamanya dan hanya bisa dibebaskan lewat SQL manual. |
| D5 | **Selesai ikut dikunci** | Menutup sesi adalah bagian dari penanganan. Petugas B tak boleh menutup pekerjaan petugas A. |
| D6 | **Backfill 1 sesi berjalan ke Irma**, tanpa notifikasi | Menghapus gangguan sekali-jalan saat rilis. Tanpa notifikasi karena pemohon sudah dilayani berhari-hari — pesan "sedang ditangani" hanya akan membingungkan. |

## 4. Aturan main (hasil akhir)

| Peran | Lihat inbox + baca chat | Ambil alih | Kirim chat · Proses · Selesai · Form Data | Lepaskan |
| --- | --- | --- | --- | --- |
| `pimpinan` | ✅ | ❌ | ❌ *(read-only, tak berubah)* | ❌ |
| `petugas_pst`, `operator` | ✅ | ✅ bila belum diklaim | ✅ **hanya bila dia pemegangnya** | ❌ |
| `admin`, `superadmin` | ✅ | ❌ **(baru)** | ✅ selalu, tanpa klaim | ✅ **(baru)** |
| `resepsionis`, `verifikator` | ❌ | ❌ | ❌ | ❌ |

Peran `resepsionis`/`verifikator` sudah ditolak `inbox()` (`Wa.php:768`) dan tak
tersentuh perubahan ini.

## 5. Perubahan backend — `Wa.php`

### 5.1 Balik guard inti jadi fail-closed *(jantung perubahan)*

Ganti isi `wa_require_session_owner($sess)` (`Wa.php:1556-1567`). Nama fungsi
dipertahankan — setelah perubahan justru lebih akurat, dan ketiga pemanggil yang
sudah ada tak perlu disentuh.

```php
// Gerbang wajib-klaim: sesi hanya boleh ditulis oleh pemegangnya. Sesi yang BELUM
// diklaim tertutup — petugas harus menekan "Ambil alih" dulu, agar setiap penanganan
// punya pemilik tercatat dan pemohon selalu diberi tahu siapa yang menanganinya.
// admin/superadmin dikecualikan: pengawas yang boleh bertindak tanpa memiliki sesi (D3/D4).
private function wa_require_session_owner($sess) {
    $role = $this->current_user->role ?? '';
    if (in_array($role, ['admin', 'superadmin'], true)) return;
    if (!$sess) {
        $this->json_response(['success' => false, 'message' => 'Sesi tidak ditemukan'], 404);
    }
    $assigned = (int) ($sess->assigned_to ?? 0);
    if ($assigned === 0) {
        $this->json_response(['success' => false,
            'message' => 'Ambil alih sesi ini dulu sebelum memproses atau membalas chat.'], 409);
    }
    if ($assigned !== (int) ($this->current_user->id ?? 0)) {
        $this->json_response(['success' => false,
            'message' => 'Sesi ini sedang ditangani operator lain.'], 403);
    }
}
```

Perubahan perilaku: `!$sess` dan `assigned === 0` yang tadinya `return` (lolos)
kini menolak. Kode status dibedakan sengaja — **409** berarti "belum diklaim,
ambil alih dulu" (bisa dipulihkan pengguna), **403** berarti "milik orang lain"
(tak bisa dipulihkan sendiri). Frontend membedakan keduanya lewat pesan backend.

### 5.2 Helper baru

```php
// Klaim adalah milik petugas lapangan. admin/superadmin adalah pengawas:
// melihat semua & boleh bertindak, tapi tak pernah memiliki sesi (D4).
private function wa_can_claim() {
    return in_array($this->current_user->role ?? '', ['petugas_pst', 'operator'], true);
}

// Sesi terbaru milik sebuah kunjungan — klaim hidup di wa_sessions, sedangkan
// visit_proses/visit_selesai hanya menerima id_kunjungan. Cermin subquery di inbox().
private function wa_session_for_visit($idKunjungan) {
    return $this->db->select('id, assigned_to')->where('id_kunjungan', (int) $idKunjungan)
                    ->order_by('id', 'DESC')->limit(1)->get('wa_sessions')->row();
}
```

### 5.3 Pasang guard di tiga endpoint yang polos

- **`visit_proses($id)`** (`Wa.php:674`) — setelah cek visit ada (`404`), sebelum
  `UPDATE`:
  `$this->wa_require_session_owner($this->wa_session_for_visit($id));`
- **`visit_selesai($id)`** (`Wa.php:690`) — setelah cek `created_by === 'whatsapp'`,
  sebelum cek status: baris yang sama. (D5)
- **`send_data_form($sid)`** (`Wa.php:254`) — `$sess` sudah dimuat di baris 259;
  sisipkan `$this->wa_require_session_owner($sess);` tepat setelah cek 404 baris
  260, sebelum cek kategori.

### 5.4 Larang admin mengklaim

Di `session_assign($id)` (`Wa.php:714`), ganti gerbang `wa_can_write()` menjadi
`wa_can_claim()`:

```php
if (!$this->wa_can_claim()) {
    $this->json_response(['success' => false,
        'message' => 'Admin tidak mengambil alih sesi. Gunakan "Lepaskan" untuk membebaskannya.'], 403);
}
```

Cabang admin-override (`Wa.php:737-741`) menjadi tak terjangkau → **dihapus**.
Sisa cabang `!$claimed`: bila `$holder === $uid` balas "Sudah Anda tangani"
(idempoten), selain itu **409** "Sudah ditangani oleh {nama}".

### 5.5 Endpoint baru — Lepaskan

```php
// POST /api/wa/sessions/(:num)/release — admin membebaskan sesi yang macet
// (pemegangnya resign/tak masuk) agar petugas lain bisa mengklaim ulang.
// Tanpa pesan WA: pengklaim berikutnya yang mengirim "sedang ditangani oleh".
public function session_release($id) { ... }
```

- Method `POST`; `require_auth()`; `require_role_in(['admin', 'superadmin'])`.
- Sesi tak ada → **404**. `assigned_to` sudah `NULL` → **200** idempoten.
- `UPDATE wa_sessions SET assigned_to = NULL, assigned_at = NULL WHERE id = ?`
- `$this->audit('wa_release', 'wa_session', $sid, ['from' => $holder]);`
- Respons: `{ success: true, data: { assigned_to: null }, message: 'Sesi dilepaskan — petugas lain dapat mengambil alih.' }`

### 5.6 Rute — `backend/application/config/routes.php`

Tambah **sebelum** `api/wa/sessions/(:num)` (rute lebih spesifik harus menang),
sejajar rute `assign` di baris 116:

```php
$route['api/wa/sessions/(:num)/release'] = 'api/wa/session_release/$1'; // POST admin-only (bebaskan sesi macet)
```

## 6. Perubahan frontend

### 6.1 `src/api/wa.ts`

```ts
// Lepaskan sesi yang macet (admin only) → assigned_to = NULL, petugas lain bisa klaim ulang.
release: (sessionId: number) =>
  apiClient.post<ApiResponse<{ assigned_to: null }>>(`/api/wa/sessions/${sessionId}/release`),
```

### 6.2 `src/pages/admin/LayananOnlineInboxPage.tsx`

`AuthUser` (`src/api/auth.ts:6`) sudah membawa `id` dan `role` — tak perlu
endpoint baru. Turunkan:

```ts
const isAdmin  = user?.role === 'admin' || user?.role === 'superadmin'
const canClaim = user?.role === 'petugas_pst' || user?.role === 'operator'
const mine     = (r: WaInboxRow) => r.assigned_to != null && r.assigned_to === user?.id
const locked   = (r: WaInboxRow) => !isAdmin && !mine(r)   // petugas yang bukan pemegang
```

Perubahan tombol per baris:

| Elemen | Sekarang | Menjadi |
| --- | --- | --- |
| "Ambil alih" | tampil bila `assigned_to == null` | tampil bila `canClaim && r.assigned_to == null` |
| Chip nama operator | dapat diklik admin → override | tak dapat diklik; admin melihat tombol **Lepaskan** di sebelahnya |
| "Proses" | selalu aktif | `disabled={locked(r)}` |
| "Selesai" | aktif bila `evaluasi_selesai` | + `disabled={locked(r)}` (D5) |
| "Form Data" | aktif bila kategori offline/lainnya | + `disabled={locked(r)}` |
| Tombol chat 💬 | selalu aktif | **tetap selalu aktif** (baca terbuka, D2) |
| Hapus 🗑 | admin only | tak berubah |

Mutasi `release` mengikuti pola `assign` yang ada (`toast` + `invalidateQueries(['wa-inbox'])`),
dengan `window.confirm`: *"Lepaskan sesi ini dari {nama}? Petugas lain akan bisa mengambil alih."*

### 6.3 Keterangan wajib-klaim *(diminta eksplisit)*

Tiga lapis, agar petugas tak pernah menebak kenapa tombol mati:

1. **Baris bantuan di bawah judul halaman**, hanya untuk yang terikat aturan
   (`canClaim`): *"Ambil alih permintaan dulu sebelum bisa memproses atau
   membalas chat."*
2. **`title` pada tombol nonaktif**: *"Ambil alih sesi ini dulu untuk memproses"*
   (Proses/Selesai/Form Data).
3. **Panel pengganti komposer di `ChatPopup`** — lihat 6.4.

### 6.4 `src/components/wa/ChatPopup.tsx`

Props baru pada `ChatPopupProps` (`ChatPopup.tsx:183`):

```ts
locked?: boolean            // true = petugas bukan pemegang sesi → hanya boleh membaca
sessionId?: number | null   // untuk tombol "Ambil alih" di dalam panel
onClaim?: () => void        // memanggil mutasi assign milik halaman inbox
```

Saat `locked`, riwayat tetap terbaca penuh, tapi komposer (textarea `:754`,
tombol lampiran, dan reaksi emoji `:232`) diganti panel:

```
┌──────────────────────────────────┐
│ 🔒 Ambil alih dulu untuk bisa    │
│    chat dengan pemohon ini       │
│          [ Ambil alih ]          │
└──────────────────────────────────┘
```

`markSeen` (`ChatPopup.tsx:266` dan `:280`) **dilewati saat `locked`**, supaya
petugas yang sekadar mengintip tidak menghapus badge belum-dibaca milik calon
pemegangnya, dan pemohon tidak menerima centang biru dari orang yang tak
menanganinya.

Halaman inbox meneruskan `locked={locked(r)}` saat membuka `ChatPopup`. Karena
`chats` state saat ini hanya menyimpan `{ phone, nama, idKunjungan }`, tambahkan
`sessionId` dan `locked` ke bentuk itu (diambil dari baris saat `openChat`).

## 7. Migrasi data

Berkas: `docs/migrations/2026-07-17-wa-claim-gate-backfill.sql`

Tanpa perubahan skema — `assigned_to`/`assigned_at` sudah ada sejak
`2026-06-11-wa-takeover-manual-close.sql`. Hanya backfill data.

**Kondisi produksi terverifikasi 2026-07-17:**

| Kondisi | Jumlah | Tindakan |
| --- | --- | --- |
| ber-kunjungan, `assigned_to` NULL, status `diproses` | **1** (sesi #636 · WA-990645 · Sariyani Basir) | → Irma (`admin_users.id = 3`) |
| ber-kunjungan, `assigned_to` NULL, status `antri` | 1 | **biarkan NULL** — belum diproses, petugas mengklaim sendiri |
| pending `expired`, tanpa kunjungan | 5 | biarkan — tak muncul di inbox (`inbox()` hanya melisting `awaiting_form`) |
| sudah diklaim (Irma 6, Fenty 1) | 7 | tak tersentuh |

```sql
-- Backfill: sesi yang penanganannya SUDAH berjalan tapi belum punya pemilik
-- tercatat, dialihkan ke Irma (id 3) — penangan dominan (6 dari 7 klaim yang ada).
-- Tanpa pemberitahuan ke responden: pesan "sedang ditangani" hanya disisipkan
-- session_assign() ke wa_outbox, dan tak ada trigger pada wa_sessions — jadi
-- UPDATE langsung ini dijamin senyap (diverifikasi via SHOW TRIGGERS, 2026-07-17).
UPDATE wa_sessions s
  JOIN tamdes_kunjungan k ON k.id_kunjungan = s.id_kunjungan
   SET s.assigned_to = 3,
       s.assigned_at = NOW()
 WHERE s.assigned_to IS NULL
   AND k.status NOT IN ('antri', 'dipanggil');
```

`NOT IN ('antri','dipanggil')` dipakai — bukan daftar-putih status — agar sesi
apa pun yang sudah melewati antrean antara sekarang dan rilis ikut terbawa.

`assigned_at = NOW()` mencatat kapan backfill dijalankan, bukan kapan penanganan
sebenarnya dimulai. Presisi palsu dihindari sengaja; kolom ini hanya untuk
catatan, tak dipakai logika apa pun.

Backfill dijalankan **saat deploy, sebelum Apache reload**, agar tak ada jendela
waktu di mana sesi #636 terkunci dari Irma.

## 8. Verifikasi

Repo ini tak punya test otomatis (`.claude/rules/testing.md`). Verifikasi manual:

**Gerbang wajib (login sebagai `petugas_pst`, mis. `wisnu`):**
1. Sesi belum diklaim → "Proses"/"Selesai"/"Form Data" nonaktif; baris bantuan tampil.
2. Buka chat sesi belum diklaim → riwayat terbaca, komposer diganti panel 🔒.
3. `curl -X POST /api/wa/visits/{id}/proses` langsung → **409**, bukan 200.
4. Klik "Ambil alih" → tombol hidup, komposer muncul, pemohon menerima "sedang ditangani oleh Wisnu".
5. Login petugas lain → sesi tadi: kirim chat ditolak **403** "ditangani operator lain".

**Admin (`admin`):**
6. Tombol "Ambil alih" **tidak** tampil di baris mana pun.
7. `curl -X POST /api/wa/sessions/{id}/assign` → **403**.
8. Proses & chat pada sesi tak-diklaim → tetap berhasil (D3).
9. "Lepaskan" pada sesi milik petugas → chip hilang, "Ambil alih" muncul lagi bagi petugas; `audit` berisi `wa_release`.

**Pimpinan:** inbox & riwayat chat tetap terbaca; tak ada tombol tulis.

**Backfill:** sesi #636 tampil "Ditangani Irma"; login sebagai `irma` → Proses & chat langsung hidup tanpa klaim ulang; **tak ada baris baru di `wa_outbox`** untuk 081242575413.

**Wajib hijau sebelum "selesai":** `cd frontend && npm run lint && npm run build`.

## 9. Risiko yang diterima sadar

- **Admin bertindak tanpa jejak pemilik** (D3): bila admin memproses sesi
  tak-diklaim, `assigned_to` tetap NULL sehingga di inbox tampak "belum
  ditangani" dan pemohon tak menerima pesan "sedang ditangani oleh". Diterima —
  persis perilaku hari ini, bukan kemunduran.
- **Sesi `antri` yang belum diklaim** akan menampilkan tombol Proses nonaktif
  sampai ada yang mengambil alih. Ini justru maksud fitur, bukan cacat.
- **Sesi `selesai` lama** yang belum diklaim ikut terbawa backfill ke Irma. Bila
  kelak ada yang perlu membalas chat sesi tertutup, Irma sudah jadi pemiliknya;
  petugas lain harus minta admin melepaskannya dulu. Frekuensinya sangat rendah
  (0 baris saat ini).

## 10. Di luar cakupan

- **`POST /api/wa/seen` sengaja tidak dipagari di backend.** Ia read-receipt
  (centang biru), bukan pesan ke pemohon. Frontend melewatinya saat terkunci
  (§6.4) agar pengintip tak menghapus badge belum-dibaca milik calon pemegang;
  pemanggilan langsung lewat `curl` masih mungkin, tapi dampaknya sebatas
  centang biru dan tak memengaruhi kepemilikan sesi.
- Reassign langsung antar-petugas (admin → petugas B). "Lepaskan" + klaim ulang
  sudah menutup kebutuhan ini dengan kode jauh lebih sedikit.
- Kedaluwarsa klaim otomatis (mis. lepas sendiri setelah N jam menganggur).
- Test otomatis pertama untuk repo ini — layak, tapi bukan bagian perubahan ini.
