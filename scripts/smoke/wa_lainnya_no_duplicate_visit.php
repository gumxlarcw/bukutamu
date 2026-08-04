<?php
// Verifikasi Wa::wa_lainnya_decision — murni logika, TIDAK menyentuh DB/jaringan.
// Menguji METODE ASLI: Wa.php dimuat dengan stub CI_Controller dan instance dibuat tanpa
// konstruktor, jadi tes ini ikut gagal bila kode produksi berubah.
//
//   php scripts/smoke/wa_lainnya_no_duplicate_visit.php     # logika produksi → LULUS
//   WA_PREFIX_LOGIC=1 php scripts/smoke/...                 # replika gerbang LAMA → WAJIB GAGAL
//
// REGRESI 2026-08-04 — satu nomor WA, DUA kunjungan terbuka.
// 081240150610 membalas 3 → 0 → 3 dalam 87 detik. Gerbang lama di
// wa_create_lainnya_visit() hanya memeriksa `state === 'submitted'`, sedangkan reset
// "0"/menu di ingest() mengosongkan state & category tapi SENGAJA mempertahankan
// id_kunjungan (dipakai konversi di session() POST). Balasan "3" kedua karena itu
// menyisipkan kunjungan 990705 lalu menimpa wa_sessions.id_kunjungan — kunjungan 990704
// jadi YATIM (tak ada baris wa_sessions yang menunjuknya), sehingga wa_session_for_visit()
// mengembalikan NULL, wa_require_session_owner() menolak 404, dan petugas mustahil
// mengambil alih atau menutupnya. Ia tersangkut 'antri' selamanya di inbox Layanan Online.

define('BASEPATH', __DIR__);
define('APPPATH', __DIR__ . '/../../backend/application/');
class CI_Controller {}
require_once APPPATH . 'modules/api/controllers/Wa.php';

// Buka akses ke metode private tanpa menjalankan konstruktor (yang butuh CI penuh).
$ref = new ReflectionClass('Wa');
$wa  = $ref->newInstanceWithoutConstructor();
$met = $ref->getMethod('wa_lainnya_decision');
$met->setAccessible(true);

$prefix = getenv('WA_PREFIX_LOGIC') === '1';

// Keputusan produksi untuk satu keadaan sesi + kunjungan yang dipegangnya.
function putus_produksi($state, $idk, $created_by, $status) {
    global $wa, $met;
    return $met->invoke($wa, $state, $idk, $created_by, $status);
}
// Replika gerbang LAMA (pra-perbaikan) — hanya 'skip' atau 'create', tak pernah 'reuse'.
function putus_lama($state, $idk, $created_by, $status) {
    return ($state === 'submitted' && $idk) ? 'skip' : 'create';
}

const SKIP   = 'skip';
const REUSE  = 'reuse';
const CREATE = 'create';

// [bagian, nama, state, id_kunjungan, visit.created_by, visit.status, harapan]
$kasus = [
    ['Sesi belum punya kunjungan — jalur normal, tetap membuat kunjungan',
        ['kontak baru pilih 3',            'awaiting_category', 0,    null,       null,     CREATE],
        ['id_kunjungan null',              'awaiting_category', null, null,       null,     CREATE],
    ],
    ['Balasan "3" ganda (TOCTOU) — perilaku lama tidak boleh berubah',
        ['submitted + kunjungan sama',     'submitted', 990705, 'whatsapp', 'antri',    SKIP],
        ['submitted walau diproses',       'submitted', 990705, 'whatsapp', 'diproses', SKIP],
    ],
    ['REGRESI 2026-08-04 — 3 → 0 → 3 wajib memakai tiket yang ADA',
        ['reset menu, kunjungan antri',    'awaiting_category', 990704, 'whatsapp', 'antri',             REUSE],
        ['reset menu, kunjungan diproses', 'awaiting_category', 990704, 'whatsapp', 'diproses',          REUSE],
        ['reset menu, menunggu_evaluasi',  'awaiting_category', 990704, 'whatsapp', 'menunggu_evaluasi', REUSE],
        ['reset menu, dipanggil',          'awaiting_category', 990704, 'whatsapp', 'dipanggil',         REUSE],
        // wa_switch_to_data() menyetel awaiting_form TAPI mempertahankan id_kunjungan.
        ['dialihkan ke form data, pilih 3', 'awaiting_form',    990704, 'whatsapp', 'antri',             REUSE],
    ],
    ['Kunjungan yang BUKAN lagi sesi berjalan → "3" ini permintaan baru',
        // Gerbang sama dengan wa_switch_to_data(): tuntas atau sudah check-in kiosk.
        ['kunjungan selesai',              'awaiting_category', 990005, 'whatsapp', 'selesai',          CREATE],
        ['kunjungan evaluasi_selesai',     'awaiting_category', 990005, 'whatsapp', 'evaluasi_selesai', CREATE],
        ['sudah check-in kiosk',           'awaiting_category', 990004, 'wa_kiosk', 'antri',            CREATE],
        ['kunjungan sudah dihapus',        'awaiting_category', 990004, null,       null,               CREATE],
    ],
    ['Bentuk masukan (baris DB selalu string) & keadaan tak terduga',
        ['id string dari DB',              'awaiting_category', '990704', 'whatsapp', 'antri', REUSE],
        ['state null (sesi hilang)',       null,                0,        null,       null,    CREATE],
        // Sesi kedaluwarsa tak pernah cocok dengan $open di ingest(), jadi ini tak terjangkau —
        // diasersi supaya defaultnya tetap aman (tak pernah menggandakan kunjungan).
        ['expired + kunjungan terbuka',    'expired',           990704,   'whatsapp', 'antri', REUSE],
    ],
];

$putus = $prefix ? 'putus_lama' : 'putus_produksi';
echo $prefix
    ? "MODE: replika gerbang LAMA (pra-perbaikan) — tes ini WAJIB GAGAL.\n"
    : "MODE: logika produksi Wa::wa_lainnya_decision.\n";

$gagal = 0;
foreach ($kasus as $bagian) {
    echo "\n" . array_shift($bagian) . ":\n";
    foreach ($bagian as $k) {
        list($nama, $state, $idk, $cb, $st, $harapan) = $k;
        $aktual = $putus($state, $idk, $cb, $st);
        if ($aktual === $harapan) {
            echo "  ok    $nama\n";
        } else {
            echo "  GAGAL $nama\n         dapat  $aktual\n         harap  $harapan\n";
            $gagal++;
        }
    }
}

echo $gagal === 0 ? "\nSEMUA LULUS\n" : "\n$gagal GAGAL\n";
exit($gagal === 0 ? 0 : 1);
