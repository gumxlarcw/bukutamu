#!/usr/bin/env bash
# wa_session_snapshot.sh — snapshot berkala sesi WhatsApp bukutamu-wa (LocalAuth).
#
# Latar (insiden 2026-07-15): host hard-crash saat chromium menulis profil →
# IndexedDB LevelDB korup → chromium diam-diam MENGHAPUS DB origin web.whatsapp.com
# saat start berikutnya → kredensial multidevice musnah → wajib relink QR.
# Snapshot ini membuat sesi bisa direstorasi tanpa relink (scripts/ops/wa_session_restore.sh).
#
# Mekanisme meniru RemoteAuth resmi wwebjs: kompres dir sesi SAAT klien hidup
# (yang esensial: Default/IndexedDB + Default/Local Storage, <1 MB); cache besar
# (Cache/Code Cache ~570 MB) di-exclude — chromium membangunnya ulang sendiri.
#
# Gate: hanya snapshot saat konektor SEHAT (wa_qr_state.ready=1 & heartbeat <120s)
# — snapshot sesi mati/menunggu-QR tidak berguna dan merusak rotasi.
# --force melewati gate (untuk forensik/uji mekanisme; JANGAN diandalkan utk restore).
#
# Cron (root): 20 */6 * * * /var/www/html/bukutamu/scripts/ops/wa_session_snapshot.sh >> /var/log/wa_session_snapshot.log 2>&1
set -euo pipefail

WA_AUTH=/var/www/html/bukutamu/wa/.wwebjs_auth
DEST=/var/backups/bukutamu-wa
KEEP=12   # 12 × 6 jam = 3 hari ke belakang
LOCK=/var/run/wa_session_snapshot.lock

FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1

exec 9>"$LOCK"
flock -n 9 || { echo "$(date -Is) skip: snapshot lain sedang jalan"; exit 0; }

if [ "$FORCE" -eq 0 ]; then
  st=$(mysql db_tamdes -N -e "SELECT CONCAT(ready,':',COALESCE(TIMESTAMPDIFF(SECOND,updated_at,NOW()),99999)) FROM wa_qr_state LIMIT 1" 2>/dev/null || echo "err:err")
  ready=${st%%:*}; age=${st##*:}
  if [ "$ready" != "1" ] || ! [ "$age" -lt 120 ] 2>/dev/null; then
    echo "$(date -Is) skip: konektor tidak sehat (ready=$ready heartbeat_age=${age}s) — snapshot hanya saat sesi hidup"
    exit 0
  fi
fi

[ -d "$WA_AUTH/session" ] || { echo "$(date -Is) GAGAL: $WA_AUTH/session tidak ada"; exit 1; }
mkdir -p "$DEST"

ts=$(date +%Y%m%d_%H%M%S)
tmp="$DEST/.tmp_$ts.tar.gz"
out="$DEST/wa_session_$ts.tar.gz"

# Profil sedang ditulis chromium → tar rc=1 ("file changed as we read it") itu NORMAL
# dan snapshot tetap terpakai (pendekatan yang sama dengan RemoteAuth). rc>1 = gagal betulan.
rc=0
tar -C "$WA_AUTH" \
  --exclude='session/Default/Cache' \
  --exclude='session/Default/Code Cache' \
  --exclude='session/Default/GPUCache' \
  --exclude='session/Default/DawnGraphiteCache' \
  --exclude='session/Default/DawnWebGPUCache' \
  --exclude='session/Default/Service Worker/CacheStorage' \
  --exclude='session/Default/blob_storage' \
  --exclude='session/GraphiteDawnCache' \
  --exclude='session/GrShaderCache' \
  --exclude='session/ShaderCache' \
  --exclude='session/component_crx_cache' \
  --exclude='session/extensions_crx_cache' \
  --exclude='session/Crashpad' \
  --exclude='session/BrowserMetrics*' \
  --exclude='*.pma' \
  --warning=no-file-changed --warning=no-file-removed \
  -czf "$tmp" session || rc=$?
if [ "$rc" -gt 1 ]; then rm -f "$tmp"; echo "$(date -Is) GAGAL: tar rc=$rc"; exit 1; fi

mv "$tmp" "$out"
echo "$(date -Is) snapshot ok: $out ($(du -h "$out" | cut -f1))"

# Rotasi: simpan KEEP terbaru.
ls -1t "$DEST"/wa_session_*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
