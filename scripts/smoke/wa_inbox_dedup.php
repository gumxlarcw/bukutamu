<?php
// Verifikasi Wa::wa_inbox_* — aturan anti-duplikat inbox Layanan Online.
// Murni logika, TIDAK menyentuh DB/jaringan.
//
//   php scripts/smoke/wa_inbox_dedup.php          # produksi → LULUS
//   WA_PREFIX_LOGIC=1 php scripts/smoke/...       # logika LAMA → WAJIB GAGAL
//
// REGRESI 2026-08-04 — inbox menampilkan nomor yang sama dua kali:
//  (a) kunjungan selesai + sesi aktif same phone (Siti Nur 990005 + 990699)
//  (b) baris pending menunggu_form + visit diproses same phone (081240150610)
//  (c) filter global status=selesai (SALAH) — menghapus SEMUA riwayat selesai

define('BASEPATH', __DIR__);
define('APPPATH', __DIR__ . '/../../backend/application/');
class CI_Controller {}
require_once APPPATH . 'modules/api/controllers/Wa.php';

$ref = new ReflectionClass('Wa');
$wa  = $ref->newInstanceWithoutConstructor();

$mOpen = $ref->getMethod('wa_inbox_phones_with_open_visit');
$mOpen->setAccessible(true);
$mShow = $ref->getMethod('wa_inbox_show_visit_row');
$mShow->setAccessible(true);
$mPend = $ref->getMethod('wa_inbox_include_pending_session');
$mPend->setAccessible(true);

$prefix = getenv('WA_PREFIX_LOGIC') === '1';

function open_map_produksi($rows) {
    global $wa, $mOpen;
    return $mOpen->invoke($wa, $rows);
}
function show_produksi($st, $tel, $map) {
    global $wa, $mShow;
    return $mShow->invoke($wa, $st, $tel, $map);
}
function pend_produksi($idk) {
    global $wa, $mPend;
    return $mPend->invoke($wa, $idk);
}

// Logika LAMA (pra-perbaikan): tampilkan semua selesai + semua awaiting_form.
function show_lama($st, $tel, $map) {
    return true;
}
function pend_lama($idk) {
    return true;
}

$showFn = $prefix ? 'show_lama' : 'show_produksi';
$pendFn = $prefix ? 'pend_lama' : 'pend_produksi';

echo $prefix
    ? "MODE: logika LAMA inbox — tes ini WAJIB GAGAL.\n"
    : "MODE: logika produksi Wa::wa_inbox_*.\n";

$gagal = 0;
function cek($nama, $aktual, $harapan) {
    global $gagal;
    if ($aktual === $harapan) {
        echo "  ok    $nama\n";
    } else {
        echo "  GAGAL $nama\n         dapat  " . var_export($aktual, true) . "\n         harap  " . var_export($harapan, true) . "\n";
        $gagal++;
    }
}

echo "\nwa_inbox_phones_with_open_visit:\n";
$map = open_map_produksi([
    (object) ['status' => 'menunggu_evaluasi', 'notel' => '081233355317'],
    (object) ['status' => 'selesai', 'notel' => '081233355317'],
    (object) ['status' => 'selesai', 'notel' => '089618672565'],
]);
cek('nomor aktif terdeteksi', !empty($map['081233355317']), true);
cek('nomor hanya selesai tidak masuk map', empty($map['089618672565']), true);

echo "\nwa_inbox_show_visit_row:\n";
cek('(a) selesai disembunyikan bila nomor punya sesi aktif',
    $showFn('selesai', '081233355317', $map), false);
cek('(c) selesai tetap tampil bila nomor hanya riwayat',
    $showFn('selesai', '089618672565', $map), true);
cek('kunjungan aktif selalu tampil',
    $showFn('diproses', '081240150610', $map), true);
cek('menunggu_evaluasi selalu tampil',
    $showFn('menunggu_evaluasi', '081233355317', $map), true);

echo "\nwa_inbox_include_pending_session:\n";
cek('(b) awaiting_form tanpa kunjungan → pending',
    $pendFn(null), true);
cek('(b) awaiting_form dengan kunjungan → BUKAN pending',
    $pendFn(990705), false);
cek('id_kunjungan 0 → pending',
    $pendFn(0), true);

echo "\nSimulasi inbox Siti Nur (990699 aktif + 990005 selesai):\n";
$siti = open_map_produksi([
    (object) ['status' => 'menunggu_evaluasi', 'notel' => '081233355317'],
    (object) ['status' => 'selesai', 'notel' => '081233355317'],
]);
$tampil = 0;
foreach ([
    ['menunggu_evaluasi', 990699],
    ['selesai', 990005],
] as $baris) {
    if ($showFn($baris[0], '081233355317', $siti)) $tampil++;
}
cek('hanya 1 baris untuk 081233355317', $tampil, 1);

echo "\nSimulasi inbox Francisca (dua selesai, tidak ada aktif):\n";
$fran = open_map_produksi([
    (object) ['status' => 'selesai', 'notel' => '089618672565'],
    (object) ['status' => 'selesai', 'notel' => '089618672565'],
]);
$tampil = 0;
foreach ([990017, 990004] as $_) {
    if ($showFn('selesai', '089618672565', $fran)) $tampil++;
}
cek('dua riwayat selesai tetap tampil', $tampil, 2);

echo $gagal === 0 ? "\nSEMUA LULUS\n" : "\n$gagal GAGAL\n";
exit($gagal === 0 ? 0 : 1);
