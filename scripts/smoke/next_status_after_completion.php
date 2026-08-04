<?php
// Verifikasi Api_base::next_status_after_completion — murni logika, TIDAK menyentuh
// DB/jaringan. Menguji METODE ASLI: Api_base.php dimuat dengan stub CI_Controller dan
// instance dibuat tanpa konstruktor, jadi tes ini ikut gagal bila kode produksi berubah.
// Jalankan: php scripts/smoke/next_status_after_completion.php

define('BASEPATH', __DIR__);
class CI_Controller {}
require_once __DIR__ . '/../../backend/application/modules/api/controllers/Api_base.php';

// Buka akses ke metode protected tanpa menjalankan konstruktor (yang butuh CI penuh).
$ref  = new ReflectionClass('Api_base');
$api  = $ref->newInstanceWithoutConstructor();
$next = $ref->getMethod('next_status_after_completion');
$next->setAccessible(true);

$gagal = 0;
function cek($nama, $aktual, $harapan) {
    global $gagal;
    if ($aktual === $harapan) {
        echo "  ok    $nama\n";
    } else {
        echo "  GAGAL $nama\n         dapat  $aktual\n         harap  $harapan\n";
        $gagal++;
    }
}
function status($layanan, $created_by = null) {
    global $api, $next;
    return $next->invoke($api, $layanan, $created_by);
}

const MENUNGGU = 'menunggu_evaluasi';
const SELESAI  = 'selesai';

echo "Kunjungan langsung (kiosk) — perilaku lama tidak boleh berubah:\n";
cek('SKD Perpustakaan',        status('["Perpustakaan"]', 'kiosk'), MENUNGGU);
cek('SKD Konsultasi',          status('["Konsultasi Statistik"]', 'kiosk'), MENUNGGU);
cek('DTSEN lewati evaluasi',   status('["Konsultasi DTSEN"]', 'kiosk'),      SELESAI);
cek('Resepsionis Lainnya',     status('["Lainnya"]', 'kiosk'),               SELESAI);
cek('Keperluan Pimpinan',      status('["Keperluan Pimpinan"]', 'kiosk'),    SELESAI);
cek('multi-layanan ada SKD',   status('["Lainnya","Perpustakaan"]', 'kiosk'), MENUNGGU);

echo "\nPemanggil lama tanpa argumen kanal (kompatibilitas mundur):\n";
cek('SKD tanpa created_by',    status('["Perpustakaan"]'), MENUNGGU);
cek('non-SKD tanpa created_by', status('["Lainnya"]'),                       SELESAI);
cek('created_by null eksplisit', status('["Lainnya"]', null),                SELESAI);

echo "\nREGRESI 2026-08-04 — sesi permintaan data online wajib dievaluasi:\n";
// Kunjungan 990699 (Siti Nur) ditutup langsung ke 'selesai' tanpa pernah mampir di
// 'menunggu_evaluasi', jadi wa_dispatch_scan tidak pernah mengantrekan eval_link dan
// pemohon hanya menerima 'thankyou'. Sebelum perbaikan, KEDUA baris di bawah = 'selesai'.
cek('Lainnya Online via WA',   status('["Lainnya Online"]', 'whatsapp'), MENUNGGU);
cek('label salah Lainnya via WA', status('["Lainnya"]', 'whatsapp'), MENUNGGU);
cek('SKD via WA',              status('["Perpustakaan"]', 'whatsapp'), MENUNGGU);

echo "\nBatas aturan kanal:\n";
// Evaluasi ditentukan kanal, TAPI DTSEN tetap dikecualikan — taksonomi di CLAUDE.md.
cek('DTSEN via WA tetap lewati', status('["Konsultasi DTSEN"]', 'whatsapp'), SELESAI);
// Hanya 'whatsapp' yang memicu; 'wa_kiosk' adalah tamu yang akhirnya datang langsung.
cek('wa_kiosk bukan kanal WA', status('["Lainnya"]', 'wa_kiosk'),            SELESAI);
cek('admin bukan kanal WA',    status('["Lainnya"]', 'admin:nayla'),         SELESAI);

echo "\nBentuk masukan jenis_layanan:\n";
cek('array PHP',               status(['Lainnya Online'], 'whatsapp'), MENUNGGU);
cek('string polos',            status('Perpustakaan', 'kiosk'), MENUNGGU);
cek('kosong via WA',           status('', 'whatsapp'), MENUNGGU);
cek('kosong via kiosk',        status('', 'kiosk'),                          SELESAI);

echo $gagal === 0 ? "\nSEMUA LULUS\n" : "\n$gagal GAGAL\n";
exit($gagal === 0 ? 0 : 1);
