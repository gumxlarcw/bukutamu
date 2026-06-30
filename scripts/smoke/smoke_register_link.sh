#!/bin/bash
# Live smoke — Kiosk::register phone-as-unique-id cross-channel linking.
# Public no-auth endpoint, no WhatsApp side-effects. Test namespace 0888399*; full cleanup.
set -u
BASE='http://127.0.0.1:60'
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then echo "  PASS: $1"; PASS=$((PASS+1)); else echo "  FAIL: $1 — expected [$2] got [$3]"; FAIL=$((FAIL+1)); fi; }
Q(){ mysql -N db_tamdes -e "$1" 2>/dev/null; }
# REG notel nama -> echoes body
REG(){ curl -s -X POST $BASE/api/kiosk/register -H 'Content-Type: application/json' \
  -d "{\"nama\":\"$2\",\"notel\":\"$1\",\"jenis_layanan\":[\"Konsultasi Statistik\"],\"sarana\":[2],\"face_descriptor\":[0.11,0.22,0.33],\"biometric_consent\":1}"; }
mkguest(){ # notel_norm face(NULL|json) via -> echo id_user
  local MX=$(Q "SELECT MAX(id_user) FROM tamdes_buku"); local ID=$((MX+1))
  Q "INSERT INTO tamdes_buku (id_user,nama,notel,registered_via,tgldatang,face_descriptor) VALUES ($ID,'$3','$1','$4',CURDATE(),$2)"
  echo $ID
}

echo "===== R1: faceless WA guest + offline register(same phone) -> REUSE ====="
WAID=$(mkguest 0888399050 NULL 'WA Faceless' 'whatsapp')
B=$(REG 62888399050 'WA Faceless')
RID=$(echo "$B" | grep -oP '"id_user":"?\K[0-9]+')
ok "R1 reused existing id_user (no new guest)" "$WAID" "$RID"
ok "R1 face now enrolled on reused guest" "1" "$([ -n "$(Q "SELECT face_descriptor FROM tamdes_buku WHERE id_user=$WAID AND face_descriptor IS NOT NULL AND face_descriptor<>''")" ] && echo 1 || echo 0)"
ok "R1 exactly ONE guest for this phone (no dup)" "1" "$(Q "SELECT COUNT(*) FROM tamdes_buku WHERE notel='0888399050'")"
ok "R1 visit created under reused id_user (created_by kiosk)" "1" "$(Q "SELECT COUNT(*) FROM tamdes_kunjungan WHERE id_user=$WAID AND created_by='kiosk'")"

echo "===== R2: brand-new phone -> NEW guest, notel normalized ====="
B=$(REG 62888399051 'Baru Onsite')
R2=$(echo "$B" | grep -oP '"id_user":"?\K[0-9]+')
ok "R2 created a guest" "1" "$([ -n "$R2" ] && echo 1 || echo 0)"
ok "R2 notel stored NORMALIZED (0888399051)" "0888399051" "$(Q "SELECT notel FROM tamdes_buku WHERE id_user=$R2")"
ok "R2 registered_via kiosk" "kiosk" "$(Q "SELECT registered_via FROM tamdes_buku WHERE id_user=$R2")"

echo "===== R3: matched guest HAS a face -> NO reuse (new guest) ====="
FACED=$(mkguest 0888399052 "'[0.9,0.8]'" 'Faced Person' 'kiosk')
B=$(REG 62888399052 'Different Person')
R3=$(echo "$B" | grep -oP '"id_user":"?\K[0-9]+')
ok "R3 did NOT reuse faced guest" "yes" "$([ "$R3" != "$FACED" ] && echo yes || echo no)"
ok "R3 now TWO guests on this phone (kept separate)" "2" "$(Q "SELECT COUNT(*) FROM tamdes_buku WHERE notel='0888399052'")"

echo "===== R4: shared number (multi-match) -> NO reuse (new guest) ====="
mkguest 0888399053 NULL 'Shared A' 'whatsapp' >/dev/null
mkguest 0888399053 NULL 'Shared B' 'whatsapp' >/dev/null
B=$(REG 62888399053 'Shared C')
ok "R4 multi-match -> created NEW (now 3 guests)" "3" "$(Q "SELECT COUNT(*) FROM tamdes_buku WHERE notel='0888399053'")"

echo "===== R5: empty phone -> NEW guest, no crash ====="
B=$(curl -s -X POST $BASE/api/kiosk/register -H 'Content-Type: application/json' \
  -d "{\"nama\":\"Tanpa HP 0888399054mark\",\"notel\":\"\",\"jenis_layanan\":[\"Konsultasi Statistik\"],\"sarana\":[2],\"face_descriptor\":[0.1],\"biometric_consent\":1}")
ok "R5 success (no empty-phone reuse/crash)" "true" "$(echo "$B" | grep -oP '"success":\K(true|false)' | head -1)"

echo "===== R7: same-day double-tap on reused guest -> same visit (no dup) ====="
V1=$(Q "SELECT id_kunjungan FROM tamdes_kunjungan WHERE id_user=$WAID ORDER BY id_kunjungan DESC LIMIT 1")
B=$(REG 62888399050 'WA Faceless')
V2=$(echo "$B" | grep -oP '"id_kunjungan":"?\K[0-9]+')
ok "R7 double-tap returns same visit (dedup fires)" "$V1" "$V2"
ok "R7 still ONE visit for reused guest" "1" "$(Q "SELECT COUNT(*) FROM tamdes_kunjungan WHERE id_user=$WAID")"

echo "===== R8: faceless guest + DIFFERENT typed nama, same phone -> NO reuse (nama guard) ====="
mkguest 0888399055 NULL 'Budi Online' 'whatsapp' >/dev/null
REG 62888399055 'Ani Berbeda' >/dev/null
ok "R8 nama mismatch -> NEW guest (no wrong-person merge)" "2" "$(Q "SELECT COUNT(*) FROM tamdes_buku WHERE notel='0888399055'")"

echo "===== R9: faceless guest + case-insensitive nama match -> REUSE ====="
C9=$(mkguest 0888399056 NULL 'Citra Dewi' 'whatsapp')
B=$(REG 62888399056 'citra dewi')
R9=$(echo "$B" | grep -oP '"id_user":"?\K[0-9]+')
ok "R9 case-insensitive nama match -> reused" "$C9" "$R9"
ok "R9 still ONE guest (no dup)" "1" "$(Q "SELECT COUNT(*) FROM tamdes_buku WHERE notel='0888399056'")"

echo "===== R10: empty-phone double-tap, same nama -> two SEPARATE guests (no merge) ====="
REG '' 'Tanpa HP 0888399057mark' >/dev/null
REG '' 'Tanpa HP 0888399057mark' >/dev/null
ok "R10 phoneless same-name -> 2 separate guests" "2" "$(Q "SELECT COUNT(*) FROM tamdes_buku WHERE nama='Tanpa HP 0888399057mark'")"

echo "===== CLEANUP ====="
TIDS=$(Q "SELECT id_user FROM tamdes_buku WHERE notel LIKE '0888399%' OR nama LIKE '%0888399%mark%'" | tr '\n' ',' | sed 's/,$//')
if [ -n "$TIDS" ]; then
  Q "DELETE FROM tamdes_kunjungan WHERE id_user IN ($TIDS)"
  Q "DELETE FROM tamdes_buku WHERE id_user IN ($TIDS)"
fi
ok "no test guests left" "0" "$(Q "SELECT COUNT(*) FROM tamdes_buku WHERE notel LIKE '0888399%' OR nama LIKE '%0888399%mark%'")"

echo
echo "===================== REGISTER-LINK SMOKE: $PASS passed, $FAIL failed ====================="
