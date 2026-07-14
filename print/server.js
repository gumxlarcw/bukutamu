// tamdes-print — print server lokal untuk thermal POS-58 di komputer kiosk.
// Dipanggil langsung oleh browser kiosk via `fetch('http://localhost:5300/print', ...)`.
// Library escpos+escpos-usb (cross-platform Windows/Linux). USB ID configurable via env.
//
// Payload yang diterima dari FE (src/hooks/usePrint.ts):
//   { no, nomor_antrian, nama, jenis_layanan, date_visit }
// Field `no` dan `nomor_antrian` keduanya berisi nilai yang sama (alias kompat).

const express = require('express');
const escpos = require('escpos');
escpos.USB = require('escpos-usb');

// ── Config (override via env) ──────────────────────────────────────────
const VID  = parseInt(process.env.PRINTER_VID || '0x0483', 16); // STMicro default
const PID  = parseInt(process.env.PRINTER_PID || '0x5840', 16);
const PORT = Number(process.env.PRINT_PORT || 5300);
const TITLE   = process.env.PRINT_TITLE   || 'BPS PROVINSI MALUKU UTARA';
const ADDRESS = process.env.PRINT_ADDRESS || 'Jl. A. Yani No. 5, Ternate';
// #45 — pin CORS ke origin kiosk (bukan '*') supaya JS dari origin lain yang terbuka di browser
// kiosk tak bisa menembak /print (buang kertas / jam antrian). Override via env kalau origin beda.
const ALLOW_ORIGIN = process.env.PRINT_ALLOW_ORIGIN || 'https://bukutamu.bpsmalut.com';

// ── App ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '64kb' }));

// CORS — browser kiosk (origin https://bukutamu.bpsmalut.com) butuh izin lintas-origin
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Helpers ────────────────────────────────────────────────────────────
function parseLayanan(raw) {
  if (!raw) return '-';
  if (Array.isArray(raw)) return raw.join(', ');
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.startsWith('[')) {
      try {
        const arr = JSON.parse(t);
        if (Array.isArray(arr)) return arr.join(', ');
      } catch { /* fall through */ }
    }
    return t;
  }
  return String(raw);
}

function formatTanggal(iso) {
  // FE kirim date_visit dari DB. Kalau parse gagal, pakai jam kiosk sekarang.
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) return new Date().toLocaleString('id-ID');
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── Routes ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    port: PORT,
    vid: '0x' + VID.toString(16).padStart(4, '0'),
    pid: '0x' + PID.toString(16).padStart(4, '0'),
  });
});

app.post('/print', (req, res) => {
  const b = req.body || {};
  // BACA `no` ATAU `nomor_antrian` — terima kedua field, tidak pakai fallback "A999".
  // Kalau benar-benar kosong, kembalikan 400 supaya bug terdeteksi, bukan tertutupi.
  const nomor = b.no || b.nomor_antrian;
  if (!nomor) {
    console.error('❌ Print request tanpa nomor:', b);
    return res.status(400).send('❌ Field "no" / "nomor_antrian" wajib');
  }

  const nama    = String(b.nama || '-').slice(0, 32);
  const layanan = parseLayanan(b.jenis_layanan).slice(0, 32);
  const tgl     = formatTanggal(b.date_visit);

  try {
    const device  = new escpos.USB(VID, PID);
    const printer = new escpos.Printer(device);

    device.open((err) => {
      if (err) {
        console.error('❌ USB open error:', err);
        return res.status(500).send('USB open error: ' + err.message);
      }

      try { // #36 — error di callback async ini TIDAK tertangkap try/catch luar → bisa crash proses
      printer
        .text('\x1B\x40')              // reset printer (ESC @)
        .align('CT')
        .style('B')
        .text(TITLE)
        .style('NORMAL')
        .text(ADDRESS)
        .text('--------------------------------')
        .text('NOMOR ANTRIAN')
        .size(2, 2)                    // double-size untuk nomor
        .text(String(nomor))
        // Reset ukuran via raw bytes — bypass `.size(1, 1)` library yang
        // tidak reliable lintas-versi:
        //   - escpos@2.5.x: .size(1,1) kirim ESC ! 0   (\x1B\x21\x00)
        //   - escpos@3.x  : .size(1,1) kirim GS  ! 0   (\x1D\x21\x00) — banyak
        //     firmware POS-58 abaikan; bug terkenal di Issue #350 lsongdev/node-escpos
        // Kirim KEDUA reset (belt-and-suspenders, 6 byte) supaya firmware
        // apapun pasti reset character size + clear all print-mode flags.
        // `.print(Buffer)` ada di semua versi escpos dan menulis bytes apa
        // adanya (tanpa iconv encoding) ke MutableBuffer.
        .print(Buffer.from([0x1B, 0x21, 0x00, 0x1D, 0x21, 0x00]))
        .text('')
        .align('LT')
        .text('Nama    : ' + nama)
        .text('Layanan : ' + layanan)
        .text('Waktu   : ' + tgl)
        .align('CT')
        .text('--------------------------------')
        .text('Silakan tunggu panggilan')
        .text('Terima kasih atas kunjungannya')
        // .cut(false, 0): tekan library default `feed(3)` (~9mm). Hardware
        // cutter sudah memaksa feed ~15-25mm dari print-head ke pisau —
        // pre-feed software apapun jadi pemborosan kertas.
        .cut(false, 0)
        // #35 — balas HANYA setelah buffer ter-flush ke USB. Sebelumnya res.send jalan sebelum flush
        // → printer mati / kertas macet di tengah job dilaporkan '✅ Tercetak' padahal gagal.
        .close((cerr) => {
          if (cerr) {
            console.error('❌ Flush/close error:', cerr);
            if (!res.headersSent) res.status(500).send('❌ Flush error: ' + cerr.message);
            return;
          }
          console.log(`✅ Tercetak: ${nomor} | ${nama} | ${layanan}`);
          if (!res.headersSent) res.send('✅ Tercetak ' + nomor);
        });
      } catch (e2) { // #36
        console.error('❌ Print error:', e2);
        if (!res.headersSent) res.status(500).send('❌ Print error: ' + e2.message);
      }
    });
  } catch (e) {
    console.error('❌ Gagal:', e);
    res.status(500).send('❌ Error: ' + e.message);
  }
});

// #36 — guard proses: error async yang lolos (mis. escpos-usb 'error' saat USB dicabut) jangan
// diam-diam mematikan server tanpa jejak. Log + exit(1) → PM2 autorestart bawa kembali bersih.
process.on('uncaughtException', (e) => { console.error('💥 uncaughtException:', e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('💥 unhandledRejection:', e); process.exit(1); });

app.listen(PORT, () => {
  console.log(`🖨️ tamdes-print aktif di http://localhost:${PORT}`);
  console.log(`   USB target VID=0x${VID.toString(16).padStart(4, '0')} PID=0x${PID.toString(16).padStart(4, '0')}`);
});
