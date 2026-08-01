#!/usr/bin/env bash
# prune_dist_assets.sh — pangkas aset lama di frontend/dist/assets BERDASARKAN UMUR.
#
# Latar (docs/AUDIT_2026-08-01.md temuan T39 / insiden 2026-07-31):
# Deploy frontend menyalin aset secara ADITIF — hash lama sengaja DIPERTAHANKAN
# supaya tab yang sudah terbuka tidak terdampar di 404. Itu penting berlipat karena
# serve.json menandai assets/** "immutable, max-age=31536000": satu 404 sekejap
# tersimpan di browser SETAHUN dan tak pernah divalidasi ulang.
#
# Konsekuensinya direktori tumbuh tanpa batas (794 berkas saat ini) dan tidak ada
# yang pernah membersihkannya.
#
# ATURAN YANG TIDAK BOLEH DILANGGAR
#   1. Pangkas HANYA berdasarkan UMUR. JANGAN PERNAH memangkas dengan logika
#      "tidak ada di build sekarang" — persis itu yang menghasilkan insiden
#      2026-07-31. Klien yang memuat halaman sebelum deploy masih meminta hash lama
#      beberapa menit (atau berjam-jam, untuk tab yang menganggur) setelahnya.
#   2. Apa pun yang DIRUJUK index.html saat ini TIDAK PERNAH dihapus, berapa pun
#      umurnya. Ini jaring pengaman kedua, bukan mekanisme utama.
#   3. Default DRY-RUN. Menghapus butuh --apply secara eksplisit.
#
# Pakai:
#   scripts/ops/prune_dist_assets.sh              # lihat apa yang akan dihapus
#   scripts/ops/prune_dist_assets.sh --apply      # benar-benar hapus
#   AGE_DAYS=60 scripts/ops/prune_dist_assets.sh  # ubah ambang umur
set -euo pipefail

DIST=/var/www/html/bukutamu/frontend/dist
ASSETS="$DIST/assets"
AGE_DAYS="${AGE_DAYS:-30}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

[ -d "$ASSETS" ] || { echo "GAGAL: $ASSETS tidak ada"; exit 1; }
[ -f "$DIST/index.html" ] || { echo "GAGAL: $DIST/index.html tidak ada — jangan pangkas tanpa build aktif"; exit 1; }

# Aset yang dirujuk build SEKARANG — dikecualikan tanpa memandang umur.
KEEP=$(grep -oE '/assets/[A-Za-z0-9._-]+' "$DIST/index.html" | sed 's#^/assets/##' | sort -u)
KEEP_COUNT=$(printf '%s\n' "$KEEP" | grep -c . || true)

total=$(find "$ASSETS" -maxdepth 1 -type f | wc -l)
echo "dist/assets: $total berkas; $KEEP_COUNT dirujuk index.html saat ini; ambang umur ${AGE_DAYS} hari"

candidates=0; skipped=0; freed=0
while IFS= read -r f; do
  b=$(basename "$f")
  if printf '%s\n' "$KEEP" | grep -qx -- "$b"; then
    skipped=$((skipped + 1))
    echo "  LINDUNGI (dirujuk build aktif): $b"
    continue
  fi
  sz=$(stat -c%s "$f")
  freed=$((freed + sz)); candidates=$((candidates + 1))
  if [ "$APPLY" -eq 1 ]; then rm -- "$f"; echo "  hapus: $b"; else echo "  akan dihapus: $b"; fi
done < <(find "$ASSETS" -maxdepth 1 -type f -mtime +"$AGE_DAYS")

echo "---"
echo "kandidat: $candidates berkas ($(numfmt --to=iec "$freed" 2>/dev/null || echo "${freed}B"))"
[ "$skipped" -gt 0 ] && echo "dilindungi meski tua: $skipped"
[ "$APPLY" -eq 1 ] && echo "MODE: dihapus" || echo "MODE: dry-run — jalankan dengan --apply untuk benar-benar menghapus"

# Setelah --apply, WAJIB dicek: setiap aset yang dirujuk index.html harus tetap 200.
if [ "$APPLY" -eq 1 ]; then
  echo "--- verifikasi pasca-pangkas ---"
  bad=0
  while IFS= read -r a; do
    [ -n "$a" ] || continue
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3060/assets/$a" || echo 000)
    [ "$code" = "200" ] || { echo "  RUSAK: /assets/$a -> $code"; bad=1; }
  done <<< "$KEEP"
  [ "$bad" -eq 0 ] && echo "  semua aset build aktif tetap 200 ✓" || { echo "  ADA YANG RUSAK — pulihkan dari dist-staging SEKARANG"; exit 1; }
fi
