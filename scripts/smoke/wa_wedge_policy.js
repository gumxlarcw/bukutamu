#!/usr/bin/env node
// Verifikasi wedgePolicy — murni logika, TIDAK menyentuh DB/jaringan/WhatsApp.
// Jalankan: node scripts/smoke/wa_wedge_policy.js
const { wedgePolicy } = require('../../wa/lib/wedge-policy');

let gagal = 0;
function cek(nama, aktual, harapan) {
  const a = JSON.stringify(aktual), h = JSON.stringify(harapan);
  if (a === h) { console.log('  ok   ' + nama); }
  else { console.log('  GAGAL ' + nama + '\n         dapat  ' + a + '\n         harap  ' + h); gagal++; }
}

const MAX = 600000;       // 10 menit
const T   = 1000000000;   // "sekarang" tetap — fungsi murni, tak memanggil Date.now()

// Sehat → heartbeat mengalir, penanda wedge dibersihkan.
cek('hidup dari bersih',   wedgePolicy(true, null,        T, MAX), { wedgeSince: null, heartbeat: true, restart: false });
cek('hidup setelah wedge', wedgePolicy(true, T - 300000,  T, MAX), { wedgeSince: null, heartbeat: true, restart: false });

// Gagal → heartbeat DITAHAN sejak kegagalan pertama (TTL 60s backend yang jadi debounce).
cek('gagal pertama',       wedgePolicy(false, null,       T, MAX), { wedgeSince: T,           heartbeat: false, restart: false });
cek('gagal 60 detik',      wedgePolicy(false, T - 60000,  T, MAX), { wedgeSince: T - 60000,   heartbeat: false, restart: false });

// Ambang berbasis WAKTU, bukan hitungan tick.
cek('tepat sebelum ambang', wedgePolicy(false, T - (MAX - 1), T, MAX), { wedgeSince: T - (MAX - 1), heartbeat: false, restart: false });
cek('tepat di ambang',      wedgePolicy(false, T - MAX,       T, MAX), { wedgeSince: T - MAX,       heartbeat: false, restart: true });
cek('melewati ambang',      wedgePolicy(false, T - (MAX * 2), T, MAX), { wedgeSince: T - (MAX * 2), heartbeat: false, restart: true });

// REGRESI 2026-08-04 — inilah cacat yang ditemukan verifikasi langsung.
// Dulu ambang dihitung per TICK. Saat wedge, satu tick makan ~100 detik karena
// terhenti dua kali di WA_OP_TIMEOUT_MS (45s) selama ada backfill mengantre, jadi
// "60 tick" sebenarnya ~100 menit, bukan 10 menit. Dengan basis waktu, lamanya
// tick tidak lagi berpengaruh: yang dihitung hanya jam dinding.
let since = null;
let tick  = 0;
for (let t = T; t <= T + MAX; t += 100000) {   // tick lambat 100 detik, seperti terukur di produksi
  const act = wedgePolicy(false, since, t, MAX);
  since = act.wedgeSince;
  tick++;
  if (act.restart) break;
}
cek('tick lambat 100s tetap restart tepat pada 10 menit', { tick, since }, { tick: 7, since: T });

// Kebalikannya: tick cepat tidak boleh mempercepat restart.
since = null;
let cepat = 0;
for (let t = T; t < T + MAX; t += 10000) {     // tick sehat 10 detik
  const act = wedgePolicy(false, since, t, MAX);
  since = act.wedgeSince;
  cepat++;
  if (act.restart) break;
}
cek('tick cepat 10s TIDAK restart sebelum 10 menit', { cepat, restart: false }, { cepat: 60, restart: false });

console.log(gagal === 0 ? '\nSEMUA LULUS' : '\n' + gagal + ' GAGAL');
process.exit(gagal === 0 ? 0 : 1);
