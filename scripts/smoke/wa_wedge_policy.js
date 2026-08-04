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

const MAX = 60;

// Sehat → heartbeat mengalir, deret ter-reset.
cek('hidup dari nol',      wedgePolicy(true,  0,  MAX), { streak: 0, heartbeat: true,  restart: false });
cek('hidup setelah gagal', wedgePolicy(true, 37,  MAX), { streak: 0, heartbeat: true,  restart: false });

// Gagal → heartbeat DITAHAN sejak kegagalan pertama (TTL 60s backend yang jadi debounce).
cek('gagal pertama',       wedgePolicy(false, 0,  MAX), { streak: 1, heartbeat: false, restart: false });
cek('gagal keenam',        wedgePolicy(false, 5,  MAX), { streak: 6, heartbeat: false, restart: false });

// Belum sampai ambang → jangan restart.
cek('tepat sebelum ambang', wedgePolicy(false, MAX - 2, MAX), { streak: MAX - 1, heartbeat: false, restart: false });

// Mencapai ambang → restart.
cek('mencapai ambang',      wedgePolicy(false, MAX - 1, MAX), { streak: MAX, heartbeat: false, restart: true });
cek('melewati ambang',      wedgePolicy(false, MAX + 3, MAX), { streak: MAX + 4, heartbeat: false, restart: true });

console.log(gagal === 0 ? '\nSEMUA LULUS' : '\n' + gagal + ' GAGAL');
process.exit(gagal === 0 ? 0 : 1);
