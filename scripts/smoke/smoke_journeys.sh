#!/bin/bash
# Live E2E JOURNEY smoke — real visitor + operator flows, chained start->finish.
# Self-contained: fake WA group (trap-restored), test phones 0888399*, mints test tokens
# from .env (localhost). Skips the live TV /call. Full cleanup incl. audit + outbox.
set -u
BASE='http://127.0.0.1:60'
PUSH=/var/www/html/bukutamu/backend/application/config/push.php
SC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRET=$(grep -oP "push_internal_secret'\]\s*=\s*'\K[^']+" "$PUSH")
FG='000000000-000000000@g.us'
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then echo "  PASS: $1"; PASS=$((PASS+1)); else echo "  FAIL: $1 — expected [$2] got [$3]"; FAIL=$((FAIL+1)); fi; }
okc(){ if echo "$3" | grep -qF "$2"; then echo "  PASS: $1"; PASS=$((PASS+1)); else echo "  FAIL: $1 — lacks [$2]: ${3:0:120}"; FAIL=$((FAIL+1)); fi; }
Q(){ mysql -N db_tamdes -e "$1" 2>/dev/null; }
ST(){ Q "SELECT status FROM tamdes_kunjungan WHERE id_kunjungan=$1"; }
inq(){ if echo "$1" | grep -qE "\"id_kunjungan\":\"?$2[\",}]"; then echo yes; else echo no; fi; }   # is id in a queue/inbox JSON?
ING(){ curl -s -X POST $BASE/api/wa/ingest -H "X-Internal-Secret: $SECRET" -H 'Content-Type: application/json' -d "{\"phone\":\"$1\",\"wa_id\":\"$1@c.us\",\"text\":\"$2\"}" >/dev/null; }
SID(){ Q "SELECT id FROM wa_sessions WHERE phone_norm='$1' ORDER BY id DESC LIMIT 1"; }
TOK(){ Q "SELECT body FROM wa_outbox WHERE phone_raw='$1' AND msg_type='intake_link' ORDER BY id DESC LIMIT 1" | grep -oP 't=\K[A-Za-z0-9._-]+' | head -1; }
# request helpers (jwt cookie / kiosk-token / plain)
J(){ local m=$1 u=$2 t=$3 d=$4; local a=(-s -X "$m" "$BASE$u" -H 'Content-Type: application/json' --cookie "jwt_token=$t"); [ -n "$d" ] && a+=(-d "$d"); curl "${a[@]}"; }
K(){ local m=$1 u=$2 t=$3 d=$4; local a=(-s -X "$m" "$BASE$u" -H 'Content-Type: application/json' -H "X-Kiosk-Token: $t"); [ -n "$d" ] && a+=(-d "$d"); curl "${a[@]}"; }
P(){ local m=$1 u=$2 d=$3; curl -s -X "$m" "$BASE$u" -H 'Content-Type: application/json' ${d:+-d "$d"}; }
idk_of(){ echo "$1" | grep -oP '"id_kunjungan":"?\K[0-9]+' | head -1; }
qstatus(){ J GET /api/consultations "$PST" '' | python3 -c "
import json,sys
for v in (json.load(sys.stdin).get('data') or []):
  if str(v.get('id_kunjungan'))=='$1': print(v.get('status')); break"; }

PST=$(php "$SC/mintjwt.php" 7 wisnu petugas_pst)
EVB='{"skor_keseluruhan":9,"kepuasan":{}}'
DATA='{"hasil_konsultasi":"Uji E2E konsultasi","kebutuhan_data":[{"rincian_data":"Produk Domestik Bruto"}]}'
REGFACE='"face_descriptor":[0.11,0.22,0.33],"biometric_consent":1'
ORIG=$(grep -oP "wa_notify_group'\]\s*=\s*'\K[^']*" "$PUSH"); cp "$PUSH" "$PUSH.smokebak"
trap 'mv -f "$PUSH.smokebak" "$PUSH" 2>/dev/null' EXIT
sed -i "s#\(\$config\['wa_notify_group'\]\s*=\s*'\)[^']*#\1$FG#" "$PUSH"
GUS=""  # collect guest ids for audit cleanup not covered by notel (none here, but safe)

echo "########## J1 — Walk-in SKD: visitor kiosk-register -> PST queue -> finalize -> eval -> selesai ##########"
P1=62888399110; N1=0888399110
B=$(P POST /api/kiosk/register "{\"nama\":\"Andi Walkin\",\"notel\":\"$P1\",\"jenis_layanan\":[\"Konsultasi Statistik\"],\"sarana\":[2],$REGFACE}")
J1=$(idk_of "$B")
ok  "J1.1 visitor registered (got id_kunjungan)" "yes" "$([ -n "$J1" ] && echo yes || echo no)"
okc "J1.1 got K queue number" "\"nomor_antrian\":\"K" "$B"
ok  "J1.2 visit shows in PST queue" "yes" "$(inq "$(J GET /api/consultations "$PST" '')" "$J1")"
J POST /api/consultations/$J1/data "$PST" "$DATA" >/dev/null
ok  "J1.3 operator filled form -> SKD soft-gate to menunggu_evaluasi" "menunggu_evaluasi" "$(ST $J1)"
KT=$(php "$SC/mintkiosk.php" eval-submit $J1 600)
R=$(K POST /api/evaluations/$J1 "$KT" "$EVB")
okc "J1.4 visitor tablet eval accepted" "Evaluasi berhasil disimpan" "$R"
ok  "J1.5 visit final = selesai" "selesai" "$(ST $J1)"
ok  "J1.5 PST queue view shows it completed (selesai)" "selesai" "$(qstatus $J1)"

echo "########## J2 — Walk-in DTSEN: register -> DTSEN queue -> finalize selesai (no eval) ##########"
P2=62888399111; N2=0888399111
B=$(P POST /api/kiosk/register "{\"nama\":\"Budi DTSEN\",\"notel\":\"$P2\",\"jenis_layanan\":[\"Konsultasi DTSEN\"],\"sarana\":[1],$REGFACE}")
J2=$(idk_of "$B")
okc "J2.1 got D queue number" "\"nomor_antrian\":\"D" "$B"
ok  "J2.2 in DTSEN queue" "yes" "$(inq "$(J GET /api/dtsen "$PST" '')" "$J2")"
ok  "J2.2 NOT in SKD queue" "no" "$(inq "$(J GET /api/consultations "$PST" '')" "$J2")"
Q "INSERT INTO dtsen_konsultasi (id_kunjungan,jenis_konsultasi_dtsen,hasil,tanggal_input) VALUES ($J2,1,1,NOW())"
J PUT /api/dtsen/$J2 "$PST" '{"status":"selesai"}' >/dev/null
ok  "J2.3 DTSEN finished directly = selesai (no eval)" "selesai" "$(ST $J2)"

echo "########## J3 — WA #2 cross-channel: WA register -> (hidden) -> kiosk check-in -> queue -> selesai ##########"
P3=62888399112; N3=0888399112
ING $P3 halo; ING $P3 2; S3=$(SID $N3); T3=$(TOK $P3)
curl -s -X POST "$BASE/api/wa/session/$S3" -H "X-Kiosk-Token: $T3" -H 'Content-Type: application/json' -d "{\"nama\":\"Citra Online\",\"jenis_layanan\":[\"Konsultasi Statistik\"],\"sarana\":[2],\"permintaan\":[]}" >/dev/null
J3=$(Q "SELECT id_kunjungan FROM wa_sessions WHERE phone_norm='$N3'")
okc "J3.1 WA #2 got K number" "K" "$(Q "SELECT nomor_antrian FROM tamdes_kunjungan WHERE id_kunjungan=$J3")"
ok  "J3.2 pre-arrival HIDDEN from PST queue (created_by whatsapp)" "no" "$(inq "$(J GET /api/consultations "$PST" '')" "$J3")"
LK=$(P POST /api/kiosk/wa-lookup "{\"phone\":\"$P3\"}"); KT3=$(echo "$LK" | grep -oP '"kiosk_token":"\K[^"]+')
NO3=$(echo "$LK" | grep -oP '"nomor_antrian":"\K[^"]+')
PR=$(K POST /api/kiosk/wa-promote "$KT3" "{\"id_kunjungan\":$J3,\"face_descriptor\":[0.1,0.2],\"biometric_consent\":1}")
okc "J3.3 kiosk check-in -> mode queue" '"mode":"queue"' "$PR"
ok  "J3.3 same number kept" "$NO3" "$(Q "SELECT nomor_antrian FROM tamdes_kunjungan WHERE id_kunjungan=$J3")"
ok  "J3.4 NOW visible in PST queue" "yes" "$(inq "$(J GET /api/consultations "$PST" '')" "$J3")"
J POST /api/consultations/$J3/data "$PST" "$DATA" >/dev/null
ok  "J3.5 operator finalize -> menunggu_evaluasi" "menunggu_evaluasi" "$(ST $J3)"
KT3E=$(php "$SC/mintkiosk.php" eval-submit $J3 600)
K POST /api/evaluations/$J3 "$KT3E" "$EVB" >/dev/null
ok  "J3.6 eval -> selesai (promoted visit = wa_kiosk, not WA)" "selesai" "$(ST $J3)"

echo "########## J4 — WA #1 data: WA request -> inbox -> take-over -> proses -> eval -> close ##########"
P4=62888399113; N4=0888399113
ING $P4 halo; ING $P4 1; S4=$(SID $N4); T4=$(TOK $P4)
curl -s -X POST "$BASE/api/wa/session/$S4" -H "X-Kiosk-Token: $T4" -H 'Content-Type: application/json' -d "{\"nama\":\"Dewi Data\",\"permintaan\":[{\"rincian_data\":\"Inflasi 2023\"}]}" >/dev/null
J4=$(Q "SELECT id_kunjungan FROM wa_sessions WHERE phone_norm='$N4'")
ok  "J4.1 WA #1 visit created (whatsapp, no number)" "whatsapp|" "$(Q "SELECT CONCAT(created_by,'|',IFNULL(nomor_antrian,'')) FROM tamdes_kunjungan WHERE id_kunjungan=$J4")"
ok  "J4.2 appears in WA inbox" "yes" "$(inq "$(J GET /api/wa/inbox "$PST" '')" "$J4")"
ok  "J4.2 NOT in PST call queue (online)" "no" "$(inq "$(J GET /api/consultations "$PST" '')" "$J4")"
R=$(J POST /api/wa/sessions/$S4/assign "$PST" '{}')
okc "J4.3 operator takes over the session" "ambil alih" "$R"
J POST /api/wa/visits/$J4/proses "$PST" '{}' >/dev/null
ok  "J4.4 marked diproses" "diproses" "$(ST $J4)"
J POST /api/consultations/$J4/data "$PST" "$DATA" >/dev/null
ok  "J4.5 data recorded -> menunggu_evaluasi" "menunggu_evaluasi" "$(ST $J4)"
KT4=$(php "$SC/mintkiosk.php" eval-submit $J4 600)
K POST /api/evaluations/$J4 "$KT4" "$EVB" >/dev/null
ok  "J4.6 WA visitor eval -> evaluasi_selesai (not selesai)" "evaluasi_selesai" "$(ST $J4)"
R=$(J POST /api/wa/visits/$J4/selesai "$PST" '{}')
ok  "J4.7 operator manual close -> selesai" "selesai" "$(ST $J4)"

echo "########## J5 — WA #3 lainnya: chat request -> inbox -> take-over -> proses ##########"
P5=62888399114; N5=0888399114
ING $P5 halo; ING $P5 3
J5=$(Q "SELECT id_kunjungan FROM wa_sessions WHERE phone_norm='$N5'"); S5=$(SID $N5)
ok  "J5.1 lainnya visit created (Lainnya Online)" '["Lainnya Online"]' "$(Q "SELECT jenis_layanan FROM tamdes_kunjungan WHERE id_kunjungan=$J5")"
ok  "J5.2 appears in WA inbox" "yes" "$(inq "$(J GET /api/wa/inbox "$PST" '')" "$J5")"
R=$(J POST /api/wa/sessions/$S5/assign "$PST" '{}'); okc "J5.3 operator takes over" "ambil alih" "$R"
J POST /api/wa/visits/$J5/proses "$PST" '{}' >/dev/null
ok  "J5.4 marked diproses" "diproses" "$(ST $J5)"

echo "########## J6 — Returning visitor (face match) -> kiosk visit -> PST queue ##########"
P6=62888399115; N6=0888399115
U6=$(( $(Q "SELECT MAX(id_user) FROM tamdes_buku") + 1 ))
Q "INSERT INTO tamdes_buku (id_user,nama,notel,registered_via,tgldatang,face_descriptor) VALUES ($U6,'Eka Returning','$N6','kiosk',CURDATE(),'[0.5,0.6]')"
B=$(P POST /api/kiosk/visit "{\"id_user\":$U6,\"jenis_layanan\":[\"Perpustakaan\"],\"sarana\":[1]}")
J6=$(idk_of "$B")
okc "J6.1 returning visit created with P number" "\"nomor_antrian\":\"P" "$B"
ok  "J6.2 in PST queue" "yes" "$(inq "$(J GET /api/consultations "$PST" '')" "$J6")"

echo "########## CLEANUP ##########"
VIDS="$J1,$J2,$J3,$J4,$J5,$J6"
ALLU=$(Q "SELECT GROUP_CONCAT(id_user) FROM tamdes_buku WHERE notel LIKE '0888399%'"); [ -z "$ALLU" ] && ALLU=0
AVIDS=$(Q "SELECT IFNULL(GROUP_CONCAT(id_kunjungan),0) FROM tamdes_kunjungan WHERE id_user IN ($ALLU)")
Q "DELETE FROM konsultasi_pengunjung WHERE id_kunjungan IN ($AVIDS)"
Q "DELETE FROM dtsen_konsultasi WHERE id_kunjungan IN ($AVIDS)"
Q "DELETE FROM tamdes_evaluasi_detail WHERE id_kunjungan IN ($AVIDS)"
Q "DELETE FROM tamdes_audit_log WHERE target_type='visit' AND target_id IN ($AVIDS,$VIDS)"
Q "DELETE FROM wa_outbox WHERE phone_raw LIKE '0888399%' OR phone_raw LIKE '62888399%' OR wa_chat_id='$FG'"
Q "DELETE FROM wa_sessions WHERE phone_norm LIKE '0888399%'"
Q "DELETE FROM tamdes_kunjungan WHERE id_user IN ($ALLU)"
Q "DELETE FROM tamdes_buku WHERE id_user IN ($ALLU)"
mv -f "$PUSH.smokebak" "$PUSH"
ok "group restored" "$ORIG" "$(grep -oP "wa_notify_group'\]\s*=\s*'\K[^']*" "$PUSH")"
ok "no test guests left" "0" "$(Q "SELECT COUNT(*) FROM tamdes_buku WHERE notel LIKE '0888399%'")"
ok "no test outbox left" "0" "$(Q "SELECT COUNT(*) FROM wa_outbox WHERE wa_chat_id='$FG' OR phone_raw LIKE '0888399%' OR phone_raw LIKE '62888399%'")"

echo
echo "===================== JOURNEY SMOKE: $PASS passed, $FAIL failed ====================="
