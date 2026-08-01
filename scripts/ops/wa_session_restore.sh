#!/usr/bin/env bash
# wa_session_restore.sh — restore snapshot sesi WhatsApp bukutamu-wa.
#
# Dipakai saat sesi HANCUR (tanda: log bukutamu-wa berulang "QR baru" + tidak pernah
# "WA client ready"), mis. pasca hard-crash host yang membuat chromium me-wipe
# IndexedDB (insiden 2026-07-15). Restore sesi tersimpan = reconnect TANPA scan QR,
# selama snapshot belum terlalu basi (sesi WhatsApp valid ± beberapa hari–14 hari).
#
# Pakai:
#   scripts/ops/wa_session_restore.sh                # snapshot terbaru
#   scripts/ops/wa_session_restore.sh <file.tar.gz>  # snapshot tertentu
#
# Kalau setelah restore tetap QR → snapshot kedaluwarsa; coba yang lebih baru
# (kalau ada) atau scan ulang di /admin/layanan-online.
set -euo pipefail

WA_AUTH=/var/www/html/bukutamu/wa/.wwebjs_auth
DEST=/var/backups/bukutamu-wa

SNAP="${1:-$(ls -1t "$DEST"/wa_session_*.tar.gz 2>/dev/null | head -1)}"
[ -n "$SNAP" ] && [ -f "$SNAP" ] || { echo "GAGAL: tidak ada snapshot di $DEST"; exit 1; }
echo "restore dari: $SNAP ($(du -h "$SNAP" | cut -f1), $(date -r "$SNAP" -Is))"

pm2 stop bukutamu-wa
sleep 2
# Chromium sisa HARUS mati sebelum profil ditukar — proses hidup di profil lama akan
# menulis balik / memegang SingletonLock dan merusak hasil restore.
pkill -f "user-data-dir=$WA_AUTH/session" 2>/dev/null || true
sleep 1

keep="$WA_AUTH/session.pre-restore.$(date +%Y%m%d_%H%M%S)"

# Rollback: tanpa ini, tar yang gagal di tengah meninggalkan konektor MATI tanpa
# dir session/ sama sekali — operator harus menebak sendiri cara pulih. Trap ini
# mengembalikan sesi sebelumnya lalu menyalakan konektor. Sisa ekstraksi TIDAK
# dihapus, hanya dipindah, supaya bisa diperiksa. (AUDIT_2026-08-01 temuan #24o)
moved=0
rollback_on_fail() {
  rc=$?
  [ "$rc" -eq 0 ] && return 0
  [ "$moved" -eq 1 ] || return 0
  echo "[!] restore GAGAL (rc=$rc) — mengembalikan sesi sebelumnya"
  if [ -d "$WA_AUTH/session" ]; then
    fail="$WA_AUTH/session.failed-restore.$(date +%Y%m%d_%H%M%S)"
    mv "$WA_AUTH/session" "$fail"
    echo "[!] hasil ekstraksi parsial dipindah ke: $fail"
  fi
  mv "$keep" "$WA_AUTH/session"
  echo "[!] sesi sebelumnya dikembalikan dari: $keep"
  pm2 start bukutamu-wa >/dev/null 2>&1 || true
  echo "[!] konektor dinyalakan ulang — pantau: pm2 logs bukutamu-wa"
}
trap rollback_on_fail EXIT

if [ -d "$WA_AUTH/session" ]; then
  mv "$WA_AUTH/session" "$keep"
  moved=1
  echo "sesi lama disimpan di: $keep (hapus manual setelah yakin restore sukses)"
fi
tar -C "$WA_AUTH" -xzf "$SNAP"

pm2 start bukutamu-wa
echo "selesai — pantau: pm2 logs bukutamu-wa"
echo "  harapan: 'WA client ready; nomor=...' TANPA QR dalam ±3 menit"
echo "  kalau tetap 'QR baru': snapshot basi → scan ulang di /admin/layanan-online"
