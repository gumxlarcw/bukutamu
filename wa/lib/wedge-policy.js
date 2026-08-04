'use strict';

// Kebijakan wedge pasca-`ready` — MURNI (tanpa I/O), supaya bisa diuji tanpa WhatsApp.
// alive      : hasil pemeriksaan hidup tick ini
// wedgeSince : epoch ms kegagalan PERTAMA dari deret berjalan, atau null bila sehat
// now        : epoch ms sekarang (disuntikkan, bukan Date.now(), agar fungsi tetap murni)
// maxMs      : lama wedge sebelum restart (WEDGE_RESTART_MS)
// → { wedgeSince, heartbeat, restart }
//
// Catatan desain: heartbeat ditahan sejak kegagalan PERTAMA. Tidak perlu ambang
// alert di sini — TTL 60 detik di backend (Wa.php:1254) yang berperan sebagai
// debounce, sehingga butuh ~60 detik wedge sebelum alert OFFLINE menyala. Blip
// satu-dua tick sembuh sendiri tanpa efek.
//
// Ambang restart memakai JAM DINDING, bukan hitungan tick. Verifikasi langsung
// 2026-08-04 menunjukkan kenapa: saat wedge, satu tick makan ~100 detik karena
// terhenti dua kali di WA_OP_TIMEOUT_MS (45 detik) selama ada baris wa_backfill
// mengantre. Ambang "60 tick" karenanya berarti ~100 menit, bukan 10 menit — dan
// paling meleset justru saat ada pekerjaan menumpuk, yang memang diciptakan oleh
// wedge itu sendiri. Dengan basis waktu, lamanya tick tidak lagi berpengaruh.
function wedgePolicy(alive, wedgeSince, now, maxMs) {
  if (alive) return { wedgeSince: null, heartbeat: true, restart: false };
  const since = wedgeSince == null ? now : wedgeSince;
  return { wedgeSince: since, heartbeat: false, restart: now - since >= maxMs };
}

module.exports = { wedgePolicy };
