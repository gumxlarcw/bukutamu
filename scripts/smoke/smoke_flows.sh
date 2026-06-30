#!/bin/bash
# Comprehensive live E2E smoke — WA online + kiosk check-in FLOWS & edge cases.
# Safety: fake group (trap-restored), test phones 62888399xxx (norm 0888399xxx),
# full cleanup keyed on normalized notel/phone_norm + fake-group wa_chat_id.
set -u
BASE='http://127.0.0.1:60'
PUSH=/var/www/html/bukutamu/backend/application/config/push.php
SECRET=$(grep -oP "push_internal_secret'\]\s*=\s*'\K[^']+" "$PUSH")
FG='000000000-000000000@g.us'
TODAY=$(date +%F); YDAY=$(date -d 'yesterday' +%F 2>/dev/null || date -v-1d +%F)
PASS=0; FAIL=0; CODE=""
ok(){ if [ "$2" = "$3" ]; then echo "  PASS: $1"; PASS=$((PASS+1)); else echo "  FAIL: $1 — expected [$2] got [$3]"; FAIL=$((FAIL+1)); fi; }
okc(){ if echo "$3" | grep -qF "$2"; then echo "  PASS: $1"; PASS=$((PASS+1)); else echo "  FAIL: $1 — lacks [$2]: ${3:0:120}"; FAIL=$((FAIL+1)); fi; }
okp(){ if [ "${3:0:1}" = "$2" ]; then echo "  PASS: $1 ($3)"; PASS=$((PASS+1)); else echo "  FAIL: $1 — want prefix [$2] got [$3]"; FAIL=$((FAIL+1)); fi; }
Q(){ mysql -N db_tamdes -e "$1" 2>/dev/null; }
ING(){ curl -s -X POST $BASE/api/wa/ingest -H "X-Internal-Secret: $SECRET" -H 'Content-Type: application/json' -d "{\"phone\":\"$1\",\"wa_id\":\"$1@c.us\",\"text\":\"$2\"}" >/dev/null; }
SID(){ Q "SELECT id FROM wa_sessions WHERE phone_norm='$1' ORDER BY id DESC LIMIT 1"; }
TOK(){ Q "SELECT body FROM wa_outbox WHERE phone_raw='$1' AND msg_type='intake_link' ORDER BY id DESC LIMIT 1" | grep -oP 't=\K[A-Za-z0-9._-]+' | head -1; }
LASTOUT(){ Q "SELECT CONCAT(msg_type,'|',body) FROM wa_outbox WHERE phone_raw='$1' ORDER BY id DESC LIMIT 1"; }
NORM(){ echo "0${1#62}"; }
# req METHOD URL TOKEN BODY -> echoes raw "BODY\nCODE" (subshell-safe; arg-array handles spaces).
req(){ local m=$1 u=$2 t=$3 d=$4; local a=(-s -w $'\n%{http_code}' -X "$m" "$BASE$u" -H 'Content-Type: application/json'); [ -n "$t" ] && a+=(-H "X-Kiosk-Token: $t"); [ -n "$d" ] && a+=(-d "$d"); curl "${a[@]}"; }
CC(){ echo "${1##*$'\n'}"; }   # status code  (last line of raw)
BB(){ echo "${1%$'\n'*}"; }    # response body (everything before last line)

ORIG=$(grep -oP "wa_notify_group'\]\s*=\s*'\K[^']*" "$PUSH"); cp "$PUSH" "$PUSH.smokebak"
trap 'mv -f "$PUSH.smokebak" "$PUSH" 2>/dev/null' EXIT   # always restore real group even on crash
sed -i "s#\(\$config\['wa_notify_group'\]\s*=\s*'\)[^']*#\1$FG#" "$PUSH"
echo "fake group set (orig=$ORIG); today=$TODAY yday=$YDAY"

off(){ ING $1 halo; ING $1 2; }
dat(){ ING $1 halo; ING $1 1; }

echo; echo "########## GROUP A: category gate routing ##########"
PA=62888399011; NA=$(NORM $PA)
ING $PA halo
ok  "A1 new contact -> awaiting_category" "awaiting_category" "$(Q "SELECT state FROM wa_sessions WHERE phone_norm='$NA'")"
okc "A1 menu sent"            "Silakan pilih layanan" "$(LASTOUT $PA)"
ok  "A1 NO group ping yet"    "0" "$(Q "SELECT COUNT(*) FROM wa_outbox WHERE wa_chat_id='$FG'")"
ING $PA 9
okc "A2 invalid choice -> re-prompt" "Mohon balas dengan angka" "$(LASTOUT $PA)"
ok  "A2 still awaiting_category" "awaiting_category" "$(Q "SELECT state FROM wa_sessions WHERE phone_norm='$NA'")"
ING $PA 1
ok  "A4 choose 1 -> awaiting_form/data" "awaiting_form|data" "$(Q "SELECT CONCAT(state,'|',category) FROM wa_sessions WHERE phone_norm='$NA'")"
okc "A4 data intake link"    "Permintaan Data" "$(LASTOUT $PA)"
ING $PA menu
ok  "A3 'menu' keyword resets" "awaiting_category|" "$(Q "SELECT CONCAT(state,'|',IFNULL(category,'')) FROM wa_sessions WHERE phone_norm='$NA'")"

PA5=62888399012; NA5=$(NORM $PA5)
ING $PA5 halo; ING $PA5 3
IDK_A5=$(Q "SELECT id_kunjungan FROM wa_sessions WHERE phone_norm='$NA5'")
ok  "A5 choose 3 -> lainnya visit, submitted" "submitted|lainnya" "$(Q "SELECT CONCAT(state,'|',category) FROM wa_sessions WHERE phone_norm='$NA5'")"
ok  "A5 visit = Lainnya Online, null number, whatsapp" '["Lainnya Online"]||whatsapp' "$(Q "SELECT CONCAT(jenis_layanan,'|',IFNULL(nomor_antrian,''),'|',created_by) FROM tamdes_kunjungan WHERE id_kunjungan=$IDK_A5")"
okc "A5 group ping 'minta ditangani'" "minta ditangani" "$(Q "SELECT body FROM wa_outbox WHERE wa_chat_id='$FG' ORDER BY id DESC LIMIT 1")"

PA6=62888399013; NA6=$(NORM $PA6)
ING $PA6 halo; ING $PA6 2; ING $PA6 1
ok  "A6 mis-cat switch -> data/awaiting_form" "awaiting_form|data" "$(Q "SELECT CONCAT(state,'|',category) FROM wa_sessions WHERE phone_norm='$NA6'")"
okc "A6 switch link mentions beralih" "beralih" "$(LASTOUT $PA6)"

echo; echo "########## GROUP B: queue number daily reset ##########"
PB=62888399014; NB=$(NORM $PB)
RC=$(Q "SELECT COUNT(*) FROM tamdes_kunjungan WHERE DATE(date_visit)='$TODAY' AND JSON_CONTAINS(jenis_layanan,'\"Rekomendasi Kegiatan Statistik\"')")
off $PB; SB=$(SID $NB); TB=$(TOK $PB)
RB=$(req POST /api/wa/session/$SB "$TB" "{\"nama\":\"Uji B\",\"jenis_layanan\":[\"Rekomendasi Kegiatan Statistik\"],\"sarana\":[2],\"permintaan\":[]}")
IDK_B=$(Q "SELECT id_kunjungan FROM wa_sessions WHERE phone_norm='$NB'")
NOB=$(Q "SELECT nomor_antrian FROM tamdes_kunjungan WHERE id_kunjungan=$IDK_B")
okp "B1 Rekomendasi -> 'R' prefix" "R" "$NOB"
ok  "B1 daily-reset sequence (today's R count+1)" "R$(printf '%03d' $((RC+1)))" "$NOB"
okc "B1 submit RESPONSE carries nomor_antrian (web shows the queue number, not WA-id)" "\"nomor_antrian\":\"$NOB\"" "$(BB "$RB")"

echo; echo "########## GROUP C: session submit validations ##########"
PC=62888399015; NC=$(NORM $PC); dat $PC; SC=$(SID $NC); TC=$(TOK $PC)
PC2=62888399016; NC2=$(NORM $PC2); dat $PC2; SC2=$(SID $NC2); TC2=$(TOK $PC2)
R=$(req POST /api/wa/session/$SC "" "{\"nama\":\"X\",\"permintaan\":[]}")
ok  "C1 no token -> 401" "401" "$(CC "$R")"
R=$(req POST /api/wa/session/$SC "$TC2" "{\"nama\":\"X\",\"permintaan\":[]}")
ok  "C2 cross-session token -> 403" "403" "$(CC "$R")"; okc "C2 msg" "tidak cocok dengan resource" "$(BB "$R")"
R=$(req POST /api/wa/session/$SC "$TC" "{\"nama\":\"\",\"permintaan\":[]}")
ok  "C3 empty nama -> 422" "422" "$(CC "$R")"; okc "C3 msg" "Nama wajib diisi" "$(BB "$R")"
PC4=62888399017; NC4=$(NORM $PC4); off $PC4; SC4=$(SID $NC4); TC4=$(TOK $PC4)
R=$(req POST /api/wa/session/$SC4 "$TC4" "{\"nama\":\"X\",\"jenis_layanan\":[],\"sarana\":[],\"permintaan\":[]}")
ok  "C4 offline empty jenis -> 422" "422" "$(CC "$R")"; okc "C4 msg" "Silakan pilih layanan" "$(BB "$R")"
R=$(req POST /api/wa/session/$SC "$TC" "{\"nama\":\"X\",\"permintaan\":[{\"rincian_data\":\"d\",\"tahun_awal\":2020,\"tahun_akhir\":2010}]}")
ok  "C5 tahun_akhir<awal -> 422" "422" "$(CC "$R")"; okc "C5 msg" "Tahun akhir tidak boleh sebelum" "$(BB "$R")"
R=$(req POST /api/wa/session/$SC "$TC" "{\"nama\":\"X\",\"permintaan\":[{\"rincian_data\":\"d\",\"tahun_awal\":1800}]}")
ok  "C6 invalid year -> 422" "422" "$(CC "$R")"; okc "C6 msg" "Tahun awal tidak valid" "$(BB "$R")"
PC7=62888399018; NC7=$(NORM $PC7); off $PC7; SC7=$(SID $NC7); TC7=$(TOK $PC7)
R=$(req POST /api/wa/session/$SC7 "$TC7" "{\"nama\":\"X\",\"jenis_layanan\":[\"Konsultasi Statistik\",\"Konsultasi DTSEN\"],\"sarana\":[2],\"permintaan\":[]}")
ok  "C7 cross-layanan -> 400" "400" "$(CC "$R")"; okc "C7 msg" "Tidak bisa mencampur" "$(BB "$R")"
PC8=62888399019; NC8=$(NORM $PC8); off $PC8; SC8=$(SID $NC8); TC8=$(TOK $PC8)
B1=$(req POST /api/wa/session/$SC8 "$TC8" "{\"nama\":\"X\",\"jenis_layanan\":[\"Perpustakaan\"],\"sarana\":[2],\"permintaan\":[]}")
ID8a=$(echo "$B1" | grep -oP '"id_kunjungan":\K[0-9]+')
B2=$(req POST /api/wa/session/$SC8 "$TC8" "{\"nama\":\"X\",\"jenis_layanan\":[\"Perpustakaan\"],\"sarana\":[2],\"permintaan\":[]}")
ID8b=$(echo "$B2" | grep -oP '"id_kunjungan":\K[0-9]+')
ok  "C8 double-submit same ticket" "$ID8a" "$ID8b"
ok  "C8 no duplicate visit for guest" "1" "$(Q "SELECT COUNT(*) FROM tamdes_kunjungan WHERE id_user=(SELECT id_user FROM tamdes_buku WHERE notel='$NC8' LIMIT 1) AND created_by='whatsapp'")"
R=$(req GET /api/wa/session/$SC "$TC" ""); A=$(CC "$R")
R=$(req GET /api/wa/session/$SC "$TC" ""); Bc=$(CC "$R")
ok  "C9 token reusable (GET x2 both 200)" "200|200" "$A|$Bc"
PC10=62888399020; NC10=$(NORM $PC10); dat $PC10; SC10=$(SID $NC10); TC10=$(TOK $PC10)
MX=$(Q "SELECT MAX(id_user) FROM tamdes_buku")
Q "INSERT INTO tamdes_buku (id_user,nama,notel,registered_via) VALUES ($((MX+1)),'Uji Dup A','$NC10','whatsapp'),($((MX+2)),'Uji Dup B','$NC10','whatsapp')"
R=$(req GET /api/wa/session/$SC10 "$TC10" ""); B=$(BB "$R")
okc "C10 multi-match -> multi_match true" '"multi_match":true' "$B"
okc "C10 multi-match -> guest null"       '"guest":null' "$B"

echo; echo "########## GROUP D: kiosk check-in edge cases ##########"
PD1=62888399021; ND1=$(NORM $PD1); off $PD1; SD1=$(SID $ND1); TD1=$(TOK $PD1)
req POST /api/wa/session/$SD1 "$TD1" "{\"nama\":\"Uji D1\",\"jenis_layanan\":[\"Konsultasi Statistik\"],\"sarana\":[2],\"permintaan\":[]}" >/dev/null
IDK_D1=$(Q "SELECT id_kunjungan FROM wa_sessions WHERE phone_norm='$ND1'")
Q "UPDATE tamdes_kunjungan SET date_visit='$YDAY 10:00:00', nomor_antrian='K099' WHERE id_kunjungan=$IDK_D1"
LK=$(BB "$(req POST /api/kiosk/wa-lookup "" "{\"phone\":\"$PD1\"}")")
okc "D1 lookup returns stale number K099" "K099" "$LK"
KT=$(echo "$LK" | grep -oP '"kiosk_token":"\K[^"]+')
PR=$(BB "$(req POST /api/kiosk/wa-promote "$KT" "{\"id_kunjungan\":$IDK_D1,\"face_descriptor\":[0.1,0.2],\"biometric_consent\":1}")")
okc "D1 promote mode queue" '"mode":"queue"' "$PR"
NOD1=$(Q "SELECT nomor_antrian FROM tamdes_kunjungan WHERE id_kunjungan=$IDK_D1")
okp "D1 stale-day regenerated to today's K" "K" "$NOD1"
ok  "D1 number changed from yesterday's K099" "yes" "$([ "$NOD1" != "K099" ] && echo yes || echo no)"
ok  "D1 promoted -> wa_kiosk" "wa_kiosk" "$(Q "SELECT created_by FROM tamdes_kunjungan WHERE id_kunjungan=$IDK_D1")"

PD2=62888399022; ND2=$(NORM $PD2); off $PD2; SD2=$(SID $ND2); TD2=$(TOK $PD2)
req POST /api/wa/session/$SD2 "$TD2" "{\"nama\":\"Uji D2\",\"jenis_layanan\":[\"Perpustakaan\"],\"sarana\":[2],\"permintaan\":[]}" >/dev/null
IDK_D2=$(Q "SELECT id_kunjungan FROM wa_sessions WHERE phone_norm='$ND2'")
KT2=$(echo "$(req POST /api/kiosk/wa-lookup "" "{\"phone\":\"$PD2\"}")" | grep -oP '"kiosk_token":"\K[^"]+')
R=$(req POST /api/kiosk/wa-promote "$KT2" "{\"id_kunjungan\":$IDK_D2,\"biometric_consent\":1}")
ok  "D2 promote no-face -> 422" "422" "$(CC "$R")"; okc "D2 msg" "Pemindaian wajah diperlukan" "$(BB "$R")"

PD3=62888399023; ND3=$(NORM $PD3); off $PD3; SD3=$(SID $ND3); TD3=$(TOK $PD3)
req POST /api/wa/session/$SD3 "$TD3" "{\"nama\":\"Uji D3\",\"jenis_layanan\":[\"Perpustakaan\"],\"sarana\":[2],\"permintaan\":[]}" >/dev/null
IDK_D3=$(Q "SELECT id_kunjungan FROM wa_sessions WHERE phone_norm='$ND3'")
KT3=$(echo "$(req POST /api/kiosk/wa-lookup "" "{\"phone\":\"$PD3\"}")" | grep -oP '"kiosk_token":"\K[^"]+')
R=$(req POST /api/kiosk/wa-promote "$KT3" "{\"id_kunjungan\":$IDK_D3,\"face_descriptor\":[0.1],\"biometric_consent\":1}"); A=$(CC "$R")
R=$(req POST /api/kiosk/wa-promote "$KT3" "{\"id_kunjungan\":$IDK_D3,\"face_descriptor\":[0.1],\"biometric_consent\":1}")
ok  "D3 1st promote 200" "200" "$A"
ok  "D3 2nd promote -> 409" "409" "$(CC "$R")"; okc "D3 msg" "sudah diproses" "$(BB "$R")"

PD4=62888399024; ND4=$(NORM $PD4); off $PD4; SD4=$(SID $ND4); TD4=$(TOK $PD4)
req POST /api/wa/session/$SD4 "$TD4" "{\"nama\":\"Uji D4\",\"jenis_layanan\":[\"Perpustakaan\"],\"sarana\":[2],\"permintaan\":[]}" >/dev/null
IDK_D4=$(Q "SELECT id_kunjungan FROM wa_sessions WHERE phone_norm='$ND4'")
Q "UPDATE tamdes_kunjungan SET status='selesai' WHERE id_kunjungan=$IDK_D4"
R=$(req POST /api/kiosk/wa-lookup "" "{\"phone\":\"$PD4\"}")
ok  "D4 lookup on selesai -> 409" "409" "$(CC "$R")"; okc "D4 msg" "sudah selesai" "$(BB "$R")"

PD5=62888399025; ND5=$(NORM $PD5)
MX=$(Q "SELECT MAX(id_user) FROM tamdes_buku")
Q "INSERT INTO tamdes_buku (id_user,nama,notel,registered_via) VALUES ($((MX+1)),'Uji Dup C','$ND5','whatsapp'),($((MX+2)),'Uji Dup D','$ND5','whatsapp')"
R=$(req POST /api/kiosk/wa-lookup "" "{\"phone\":\"$PD5\"}")
ok  "D5 lookup multi-match -> 409" "409" "$(CC "$R")"; okc "D5 msg" "lebih dari satu" "$(BB "$R")"

R=$(req POST /api/kiosk/wa-promote "" "{\"id_kunjungan\":0,\"face_descriptor\":[0.1]}")
ok  "D6 promote id<=0 -> 422" "422" "$(CC "$R")"; okc "D6 msg" "id_kunjungan diperlukan" "$(BB "$R")"

echo; echo "########## CLEANUP ##########"
TIDS=$(Q "SELECT id_user FROM tamdes_buku WHERE notel LIKE '0888399%'" | tr '\n' ',' | sed 's/,$//')
TVIS="0"
if [ -n "$TIDS" ]; then
  TVIS=$(Q "SELECT IFNULL(GROUP_CONCAT(id_kunjungan),'0') FROM tamdes_kunjungan WHERE id_user IN ($TIDS)")
  Q "DELETE FROM konsultasi_pengunjung WHERE id_kunjungan IN (SELECT id_kunjungan FROM tamdes_kunjungan WHERE id_user IN ($TIDS))"
  Q "DELETE FROM tamdes_kunjungan WHERE id_user IN ($TIDS)"
  Q "DELETE FROM tamdes_buku WHERE id_user IN ($TIDS)"
fi
Q "DELETE FROM wa_sessions WHERE phone_norm LIKE '0888399%'"
Q "DELETE FROM wa_outbox WHERE phone_raw LIKE '0888399%' OR phone_raw LIKE '62888399%' OR wa_chat_id='$FG'"

mv -f "$PUSH.smokebak" "$PUSH"
ok "group restored" "$ORIG" "$(grep -oP "wa_notify_group'\]\s*=\s*'\K[^']*" "$PUSH")"

echo "--- residual (all 0) ---"
ok "no test guests"   "0" "$(Q "SELECT COUNT(*) FROM tamdes_buku WHERE notel LIKE '0888399%'")"
ok "no test sessions" "0" "$(Q "SELECT COUNT(*) FROM wa_sessions WHERE phone_norm LIKE '0888399%'")"
ok "no test outbox"   "0" "$(Q "SELECT COUNT(*) FROM wa_outbox WHERE phone_raw LIKE '0888399%' OR phone_raw LIKE '62888399%' OR wa_chat_id='$FG'")"
ok "no test visits"   "0" "$(Q "SELECT COUNT(*) FROM tamdes_kunjungan WHERE id_kunjungan IN ($TVIS)")"

echo; echo "===================== FLOWS SMOKE: $PASS passed, $FAIL failed ====================="
