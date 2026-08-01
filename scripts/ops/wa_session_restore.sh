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
if [ -d "$WA_AUTH/session" ]; then
  mv "$WA_AUTH/session" "$keep"
  echo "sesi lama disimpan di: $keep (hapus manual setelah yakin restore sukses)"
fi
tar -C "$WA_AUTH" -xzf "$SNAP"

pm2 start bukutamu-wa
echo "selesai — pantau: pm2 logs bukutamu-wa"
echo "  harapan: 'WA client ready; nomor=...' TANPA QR dalam ±3 menit"
echo "  kalau tetap 'QR baru': snapshot basi → scan ulang di /admin/layanan-online"
