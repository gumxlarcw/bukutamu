<?php
// Verifikasi Wa::wa_reaper_should_preserve — murni logika, TIDAK menyentuh DB.
//
//   php scripts/smoke/wa_reaper_preserve.php     # logika produksi → LULUS
//   WA_PREFIX_LOGIC=1 php scripts/smoke/...      # replika LAMA (expire semua) → WAJIB GAGAL
//
// REGRESI 2026-08-04 — reaper 48h kedaluwarsakan sesi awaiting_form yang masih
// memegang kunjungan diproses. Setelah expired, pesan masuk tidak cocok query reuse
// → sesi baru → kunjungan ganda (celah terjadwal 6 Ag 2026, sesi 643/644).

define('BASEPATH', __DIR__);
define('APPPATH', __DIR__ . '/../../backend/application/');
class CI_Controller {}
require_once APPPATH . 'modules/api/controllers/Wa.php';

$ref = new ReflectionClass('Wa');
$wa  = $ref->newInstanceWithoutConstructor();
$met = $ref->getMethod('wa_reaper_should_preserve');
$met->setAccessible(true);

$prefix = getenv('WA_PREFIX_LOGIC') === '1';

function preserve_produksi($idk, $cb, $st) {
    global $wa, $met;
    return $met->invoke($wa, $idk, $cb, $st);
}
// Replika LAMA: reaper tidak pernah mempertahankan sesi (expire semua stale).
function preserve_lama($idk, $cb, $st) {
    return false;
}

$kasus = [
    ['Sesi tanpa kunjungan — boleh kedaluwarsa',
        ['id_kunjungan null',           0,    null,       null,              false],
        ['id_kunjungan 0',              0,    null,       null,              false],
    ],
    ['REGRESI — kunjungan WA terbuka WAJIB dipertahankan',
        ['antri',                       990704, 'whatsapp', 'antri',          true],
        ['diproses',                    990705, 'whatsapp', 'diproses',       true],
        ['menunggu_evaluasi',           990699, 'whatsapp', 'menunggu_evaluasi', true],
        ['dipanggil',                   990701, 'whatsapp', 'dipanggil',      true],
    ],
    ['Kunjungan sudah tuntas — sesi boleh kedaluwarsa',
        ['selesai',                     990005, 'whatsapp', 'selesai',        false],
        ['evaluasi_selesai',            990004, 'whatsapp', 'evaluasi_selesai', false],
    ],
    ['Bukan kanal WA — sesi boleh kedaluwarsa meski visit masih antri',
        ['wa_kiosk',                    990010, 'wa_kiosk', 'antri',          false],
        ['kiosk',                       990011, 'kiosk',    'proses',         false],
    ],
    ['Bentuk masukan dari DB',
        ['id string',                   '990704', 'whatsapp', 'diproses',     true],
    ],
];

$fn = $prefix ? 'preserve_lama' : 'preserve_produksi';
echo $prefix
    ? "MODE: replika reaper LAMA (expire semua) — tes ini WAJIB GAGAL.\n"
    : "MODE: logika produksi Wa::wa_reaper_should_preserve.\n";

$gagal = 0;
foreach ($kasus as $bagian) {
    echo "\n" . array_shift($bagian) . ":\n";
    foreach ($bagian as $k) {
        list($nama, $idk, $cb, $st, $harapan) = $k;
        $aktual = $fn($idk, $cb, $st);
        if ($aktual === $harapan) {
            echo "  ok    $nama\n";
        } else {
            echo "  GAGAL $nama\n         dapat  " . ($aktual ? 'true' : 'false') . "\n         harap  " . ($harapan ? 'true' : 'false') . "\n";
            $gagal++;
        }
    }
}

echo $gagal === 0 ? "\nSEMUA LULUS\n" : "\n$gagal GAGAL\n";
exit($gagal === 0 ? 0 : 1);
