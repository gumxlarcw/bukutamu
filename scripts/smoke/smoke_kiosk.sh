#!/bin/bash
# Live E2E smoke — Kiosk WA Check-in Flow (happy paths + call-queue exclusion invariant).
# Self-contained: sets a FAKE wa_notify_group (trap-restored), uses fake 0888399* phones,
# full cleanup. See scripts/smoke/README.md for prerequisites & safety notes.
set -u
BASE='http://127.0.0.1:60'
PUSH=/var/www/html/bukutamu/backend/application/config/push.php
SECRET=$(grep -oP "push_internal_secret'\]\s*=\s*'\K[^']+" "$PUSH")
FG='000000000-000000000@g.us'
TODAY=$(date +%F)
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then echo "  PASS: $1"; PASS=$((PASS+1)); else echo "  FAIL: $1 — expected [$2] got [$3]"; FAIL=$((FAIL+1)); fi; }
okc(){ if echo "$3" | grep -qF "$2"; then echo "  PASS: $1"; PASS=$((PASS+1)); else echo "  FAIL: $1 — lacks [$2]: ${3:0:120}"; FAIL=$((FAIL+1)); fi; }
Q(){ mysql -N db_tamdes -e "$1" 2>/dev/null; }
ING(){ curl -s -X POST $BASE/api/wa/ingest -H "X-Internal-Secret: $SECRET" -H 'Content-Type: application/json' -d "{\"phone\":\"$1\",\"wa_id\":\"$1@c.us\",\"text\":\"$2\"}" >/dev/null; }
TOK(){ Q "SELECT body FROM wa_outbox WHERE phone_raw='$1' AND msg_type='intake_link' ORDER BY id DESC LIMIT 1" | grep -oP 't=\K[A-Za-z0-9._-]+' | head -1; }
SID(){ Q "SELECT id FROM wa_sessions WHERE phone_norm='$1' ORDER BY id DESC LIMIT 1"; }
SUB(){ curl -s -X POST "$BASE/api/wa/session/$1" -H "X-Kiosk-Token: $2" -H 'Content-Type: application/json' -d "$3"; }
LOOKUP(){ curl -s -X POST $BASE/api/kiosk/wa-lookup -H 'Content-Type: application/json' -d "{\"phone\":\"$1\"}"; }
PROMOTE(){ curl -s -X POST $BASE/api/kiosk/wa-promote -H "X-Kiosk-Token: $1" -H 'Content-Type: application/json' -d "$2"; }
# Replicated index WHEREs — the live call-queue endpoints are auth-gated; we assert the
# pre-arrival exclusion invariant via the same SQL the controllers use.
IN_SKD(){ Q "SELECT COUNT(*) FROM tamdes_kunjungan k WHERE k.id_kunjungan=$1 AND DATE(k.date_visit)='$TODAY' AND (k.jenis_layanan LIKE '%Perpustakaan%' OR k.jenis_layanan LIKE '%Konsultasi Statistik%' OR k.jenis_layanan LIKE '%Rekomendasi Kegiatan Statistik%' OR k.jenis_layanan LIKE '%Penjualan Produk Statistik%') AND (k.created_by IS NULL OR k.created_by <> 'whatsapp')"; }
IN_DTSEN(){ Q "SELECT COUNT(*) FROM tamdes_kunjungan k WHERE k.id_kunjungan=$1 AND DATE(k.date_visit)='$TODAY' AND k.jenis_layanan LIKE '%Konsultasi DTSEN%' AND (k.created_by IS NULL OR k.created_by <> 'whatsapp')"; }

ORIG=$(grep -oP "wa_notify_group'\]\s*=\s*'\K[^']*" "$PUSH"); cp "$PUSH" "$PUSH.smokebak"
trap 'mv -f "$PUSH.smokebak" "$PUSH" 2>/dev/null' EXIT
sed -i "s#\(\$config\['wa_notify_group'\]\s*=\s*'\)[^']*#\1$FG#" "$PUSH"
echo "fake group set (orig=$ORIG); today=$TODAY"

P1=62888399031; N1=0888399031   # #2 Konsultasi Statistik (promote round-trip)
P2=62888399032; N2=0888399032   # #2 Konsultasi Statistik (sequential)
P3=62888399033; N3=0888399033   # #2 Konsultasi DTSEN
P5=62888399035; N5=0888399035   # #1 data
P6=62888399036; N6=0888399036   # #3 lainnya
P8=62888399038; N8=0888399038   # #2 with sarana 32 + sarana_lainnya parity

mk_offline(){ # phone norm jenis sarana [extra-json] -> echo id_kunjungan
  local P=$1 N=$2 JL=$3 SR=$4 EXTRA=${5:-}
  ING $P halo; ING $P 2
  local s=$(SID $N) t=$(TOK $P)
  SUB $s "$t" "{\"nama\":\"Uji $N\",\"jenis_layanan\":[\"$JL\"],\"sarana\":[$SR],\"permintaan\":[]$EXTRA}" >/dev/null
  Q "SELECT id_kunjungan FROM wa_sessions WHERE phone_norm='$N'"
}

echo "===== C1: #2 Konsultasi Statistik -> K-number, created_by whatsapp, EXCLUDED from SKD queue ====="
IDK1=$(mk_offline $P1 $N1 "Konsultasi Statistik" 2)
ok "C1 created_by whatsapp" "whatsapp" "$(Q "SELECT created_by FROM tamdes_kunjungan WHERE id_kunjungan=$IDK1")"
okc "C1 has K-number" "K" "$(Q "SELECT nomor_antrian FROM tamdes_kunjungan WHERE id_kunjungan=$IDK1")"
ok "C1 EXCLUDED from SKD call-queue (pre-arrival)" "0" "$(IN_SKD $IDK1)"

echo "===== C2: 2nd #2 Konsultasi Statistik -> sequential distinct number ====="
IDK2=$(mk_offline $P2 $N2 "Konsultasi Statistik" 2)
NO1=$(Q "SELECT nomor_antrian FROM tamdes_kunjungan WHERE id_kunjungan=$IDK1")
NO2=$(Q "SELECT nomor_antrian FROM tamdes_kunjungan WHERE id_kunjungan=$IDK2")
ok "C2 numbers distinct (not both K001)" "yes" "$([ "$NO1" != "$NO2" ] && echo yes || echo no)"

echo "===== C3: #2 Konsultasi DTSEN -> D-number, EXCLUDED from DTSEN queue ====="
IDK3=$(mk_offline $P3 $N3 "Konsultasi DTSEN" 1)
okc "C3 has D-number" "D" "$(Q "SELECT nomor_antrian FROM tamdes_kunjungan WHERE id_kunjungan=$IDK3")"
ok "C3 EXCLUDED from DTSEN call-queue (pre-arrival)" "0" "$(IN_DTSEN $IDK3)"

echo "===== C4: kiosk check-in #2 KS -> keeps number, wa_kiosk, NOW in SKD queue ====="
LK=$(LOOKUP $P1)
okc "C4 wa-lookup returns number" "$NO1" "$LK"
KT=$(echo "$LK" | grep -oP '"kiosk_token":"\K[^"]+')
PR=$(PROMOTE "$KT" "{\"id_kunjungan\":$IDK1,\"face_descriptor\":[0.1,0.2,0.3],\"biometric_consent\":1}")
okc "C4 promote success" '"success":true' "$PR"
okc "C4 promote mode queue" '"mode":"queue"' "$PR"
ok "C4 created_by wa_kiosk" "wa_kiosk" "$(Q "SELECT created_by FROM tamdes_kunjungan WHERE id_kunjungan=$IDK1")"
ok "C4 number unchanged" "$NO1" "$(Q "SELECT nomor_antrian FROM tamdes_kunjungan WHERE id_kunjungan=$IDK1")"
ok "C4 NOW included in SKD call-queue" "1" "$(IN_SKD $IDK1)"

echo "===== C5: #1 (data) -> no number; kiosk -> Resepsionis ====="
ING $P5 halo; ING $P5 1
s=$(SID $N5); t=$(TOK $P5)
SUB $s "$t" "{\"nama\":\"Uji Data\",\"permintaan\":[{\"rincian_data\":\"X\"}]}" >/dev/null
IDK5=$(Q "SELECT id_kunjungan FROM wa_sessions WHERE phone_norm='$N5'")
ok "C5 #1 has NO number" "" "$(Q "SELECT IFNULL(nomor_antrian,'') FROM tamdes_kunjungan WHERE id_kunjungan=$IDK5")"
LK5=$(LOOKUP $P5); KT5=$(echo "$LK5" | grep -oP '"kiosk_token":"\K[^"]+')
PR5=$(PROMOTE "$KT5" "{\"id_kunjungan\":$IDK5,\"face_descriptor\":[0.1,0.2],\"biometric_consent\":1}")
okc "C5 promote mode resepsionis" '"mode":"resepsionis"' "$PR5"
ok "C5 became Lainnya (resepsionis)" '["Lainnya"]' "$(Q "SELECT jenis_layanan FROM tamdes_kunjungan WHERE id_kunjungan=$IDK5")"
ok "C5 wa_kiosk, null number" "wa_kiosk|" "$(Q "SELECT CONCAT(created_by,'|',IFNULL(nomor_antrian,'')) FROM tamdes_kunjungan WHERE id_kunjungan=$IDK5")"

echo "===== C6: #3 (lainnya) -> kiosk -> Resepsionis ====="
ING $P6 halo; ING $P6 3
IDK6=$(Q "SELECT id_kunjungan FROM wa_sessions WHERE phone_norm='$N6'")
LK6=$(LOOKUP $P6); KT6=$(echo "$LK6" | grep -oP '"kiosk_token":"\K[^"]+')
PR6=$(PROMOTE "$KT6" "{\"id_kunjungan\":$IDK6,\"face_descriptor\":[0.3],\"biometric_consent\":1}")
okc "C6 promote mode resepsionis" '"mode":"resepsionis"' "$PR6"

echo "===== C7: kiosk wa-lookup truly-unknown phone -> 404 (no guest) ====="
okc "C7 unknown -> not registered" "tidak terdaftar melalui layanan online" "$(LOOKUP 62888399099)"

echo "===== C8: offline submit persists sarana_lainnya (parity fix) ====="
IDK8=$(mk_offline $P8 $N8 "Konsultasi Statistik" 32 ",\"sarana_lainnya\":\"Zoom Meeting\"")
ok "C8 sarana_lainnya stored" "Zoom Meeting" "$(Q "SELECT IFNULL(sarana_lainnya,'') FROM tamdes_kunjungan WHERE id_kunjungan=$IDK8")"

echo "===== C9: biometric VERIFY (already-enrolled guest) — MATCH -> promote OK, template kept ====="
PV=62888399041; NV=0888399041
UV=$(Q "SELECT IFNULL(MAX(id_user),8200000)+1 FROM tamdes_buku")
Q "INSERT INTO tamdes_buku (id_user,nama,notel,registered_via,tgldatang,face_descriptor,biometric_consent) VALUES ($UV,'Uji Verify','$NV','kiosk',CURDATE(),'[0.10,0.20,0.30]',1)"
Q "INSERT INTO tamdes_kunjungan (id_user,jenis_layanan,sarana,date_visit,status,nomor_antrian,created_by) VALUES ($UV,JSON_ARRAY('Konsultasi Statistik'),JSON_ARRAY(2),NOW(),'antri','K700','whatsapp')"
IDV=$(Q "SELECT id_kunjungan FROM tamdes_kunjungan WHERE id_user=$UV ORDER BY id_kunjungan DESC LIMIT 1")
KTV=$(echo "$(LOOKUP $PV)" | grep -oP '"kiosk_token":"\K[^"]+')
PRV=$(PROMOTE "$KTV" "{\"id_kunjungan\":$IDV,\"face_descriptor\":[0.10,0.20,0.30],\"biometric_consent\":1}")
okc "C9 verify MATCH -> promote success" '"success":true' "$PRV"
ok  "C9 template NOT overwritten (kept original)" "[0.10,0.20,0.30]" "$(Q "SELECT face_descriptor FROM tamdes_buku WHERE id_user=$UV")"
ok  "C9 promoted to wa_kiosk" "wa_kiosk" "$(Q "SELECT created_by FROM tamdes_kunjungan WHERE id_kunjungan=$IDV")"

echo "===== C10: biometric VERIFY — NO MATCH -> reject, NOT promoted (anti-impersonation) ====="
PW=62888399042; NW=0888399042
UW=$(Q "SELECT IFNULL(MAX(id_user),8200000)+1 FROM tamdes_buku")
Q "INSERT INTO tamdes_buku (id_user,nama,notel,registered_via,tgldatang,face_descriptor,biometric_consent) VALUES ($UW,'Uji NoMatch','$NW','kiosk',CURDATE(),'[0.10,0.20,0.30]',1)"
Q "INSERT INTO tamdes_kunjungan (id_user,jenis_layanan,sarana,date_visit,status,nomor_antrian,created_by) VALUES ($UW,JSON_ARRAY('Konsultasi Statistik'),JSON_ARRAY(2),NOW(),'antri','K701','whatsapp')"
IDW=$(Q "SELECT id_kunjungan FROM tamdes_kunjungan WHERE id_user=$UW ORDER BY id_kunjungan DESC LIMIT 1")
KTW=$(echo "$(LOOKUP $PW)" | grep -oP '"kiosk_token":"\K[^"]+')
PRW=$(PROMOTE "$KTW" "{\"id_kunjungan\":$IDW,\"face_descriptor\":[0.90,0.90,0.90],\"biometric_consent\":1}")
okc "C10 verify NO-MATCH -> rejected (tidak cocok)" "tidak cocok" "$PRW"
ok  "C10 visit NOT promoted (still whatsapp)" "whatsapp" "$(Q "SELECT created_by FROM tamdes_kunjungan WHERE id_kunjungan=$IDW")"

echo "===== CLEANUP ====="
TIDS=$(Q "SELECT id_user FROM tamdes_buku WHERE notel LIKE '0888399%'" | tr '\n' ',' | sed 's/,$//')
if [ -n "$TIDS" ]; then
  Q "DELETE FROM konsultasi_pengunjung WHERE id_kunjungan IN (SELECT id_kunjungan FROM tamdes_kunjungan WHERE id_user IN ($TIDS))"
  Q "DELETE FROM tamdes_kunjungan WHERE id_user IN ($TIDS)"
  Q "DELETE FROM tamdes_buku WHERE id_user IN ($TIDS)"
fi
Q "DELETE FROM wa_sessions WHERE phone_norm LIKE '0888399%'"
Q "DELETE FROM wa_outbox WHERE phone_raw LIKE '0888399%' OR phone_raw LIKE '62888399%' OR wa_chat_id='$FG'"
mv -f "$PUSH.smokebak" "$PUSH"
ok "group restored" "$ORIG" "$(grep -oP "wa_notify_group'\]\s*=\s*'\K[^']*" "$PUSH")"
ok "no test guests"   "0" "$(Q "SELECT COUNT(*) FROM tamdes_buku WHERE notel LIKE '0888399%'")"
ok "no test sessions" "0" "$(Q "SELECT COUNT(*) FROM wa_sessions WHERE phone_norm LIKE '0888399%'")"

echo
echo "===================== KIOSK SMOKE: $PASS passed, $FAIL failed ====================="
