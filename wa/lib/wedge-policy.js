'use strict';

// Kebijakan wedge pasca-`ready` — MURNI (tanpa I/O), supaya bisa diuji tanpa WhatsApp.
// alive     : hasil pemeriksaan hidup tick ini
// streak    : jumlah kegagalan berturut SEBELUM hasil ini
// maxStreak : ambang restart (WEDGE_RESTART_TICKS)
// → { streak, heartbeat, restart }
//
// Catatan desain: heartbeat ditahan sejak kegagalan PERTAMA. Tidak perlu ambang
// alert di sini — TTL 60 detik di backend (Wa.php:1254) yang berperan sebagai
// debounce, sehingga butuh ~6 kegagalan berturut (tick 10 detik) sebelum alert
// OFFLINE menyala. Blip satu-dua tick sembuh sendiri tanpa efek.
function wedgePolicy(alive, streak, maxStreak) {
  if (alive) return { streak: 0, heartbeat: true, restart: false };
  const next = streak + 1;
  return { streak: next, heartbeat: false, restart: next >= maxStreak };
}

module.exports = { wedgePolicy };
