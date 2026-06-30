#!/bin/bash
# Live E2E smoke — VERIFIKASI (data delivery) feature. Auth via minted test JWTs (mintjwt.php).
# SAFE: guests in test namespace notel 0888399* + nama 'Uji Verif%'; "customer" phones are fake
# (62888399*) so materialized messages can't reach a real person; the verifier-notification
# (verif_request) rows that target the REAL verifier are deleted inline (killverif) to avoid spam.
# Full namespace cleanup on EXIT. Exercises the shared apply_decision state machine via the web
# endpoints (same code path the WhatsApp 1/2/3 reply uses).
set -u
BASE='http://127.0.0.1:60'
SC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then echo "  PASS: $1"; PASS=$((PASS+1)); else echo "  FAIL: $1 — expected [$2] got [$3]"; FAIL=$((FAIL+1)); fi; }
okc(){ if echo "$3" | grep -qF "$2"; then echo "  PASS: $1"; PASS=$((PASS+1)); else echo "  FAIL: $1 — lacks [$2]: ${3:0:160}"; FAIL=$((FAIL+1)); fi; }
Q(){ mysql -N db_tamdes -e "$1" 2>/dev/null; }
CC(){ echo "${1##*$'\n'}"; }
BB(){ echo "${1%$'\n'*}"; }
jval(){ echo "$1" | grep -oE "\"$2\":\"?[0-9]+" | head -1 | grep -oE '[0-9]+'; }  # CI3 returns numerics as quoted strings
jstr(){ echo "$1" | grep -oE "\"$2\":\"[^\"]*\"" | head -1 | sed "s/\"$2\":\"//;s/\"$//"; }

PST=$(php "$SC/mintjwt.php" 7 wisnu petugas_pst)
HAL=$(php "$SC/mintjwt.php" 5 halima verifikator)
SUP=$(php "$SC/mintjwt.php" 1 admin superadmin)
RESEP=$(php "$SC/mintjwt.php" 2 nayla resepsionis)

reqj(){ local m=$1 u=$2 t=$3 d=$4; local a=(-s -w $'\n%{http_code}' -X "$m" "$BASE$u" -H 'Content-Type: application/json' --cookie "jwt_token=$t"); [ -n "$d" ] && a+=(-d "$d"); curl "${a[@]}"; }
reqf(){ local m=$1 u=$2 t=$3; shift 3; local a=(-s -w $'\n%{http_code}' -X "$m" "$BASE$u" --cookie "jwt_token=$t"); for f in "$@"; do a+=(-F "$f"); done; curl "${a[@]}"; }

TESTSEL="SELECT id_user FROM tamdes_buku WHERE notel LIKE '0888399%' AND nama LIKE 'Uji Verif%'"
mkvisit(){ # seq withSession(1/0) -> echo idk
  local seq=$1 wsess=$2
  local MX=$(Q "SELECT COALESCE(MAX(id_user),9000000) FROM tamdes_buku"); local U=$((MX+1))
  Q "INSERT INTO tamdes_buku (id_user,nama,notel,registered_via,tgldatang) VALUES ($U,'Uji Verif $seq','0888399$seq','whatsapp',CURDATE())"
  Q "INSERT INTO tamdes_kunjungan (id_user,jenis_layanan,sarana,date_visit,status,nomor_antrian,created_by) VALUES ($U,JSON_ARRAY('Konsultasi Statistik'),JSON_ARRAY(2),NOW(),'proses','D$seq','whatsapp')"
  local IDK=$(Q "SELECT id_kunjungan FROM tamdes_kunjungan WHERE id_user=$U ORDER BY id_kunjungan DESC LIMIT 1")
  [ "$wsess" = "1" ] && Q "INSERT INTO wa_sessions (phone_norm,phone_raw,wa_chat_id,state,category,id_kunjungan) VALUES ('0888399$seq','62888399$seq','62888399$seq@c.us','submitted','data',$IDK)"
  echo "$IDK"
}
killverif(){ local oid=$(Q "SELECT verif_outbox_id FROM data_deliveries WHERE id=$1"); [ -n "$oid" ] && [ "$oid" != "NULL" ] && Q "DELETE FROM wa_outbox WHERE id=$oid"; }

cleanup(){
  echo "── cleanup ──"
  Q "DELETE FROM data_deliveries WHERE id_kunjungan IN (SELECT id_kunjungan FROM tamdes_kunjungan WHERE id_user IN ($TESTSEL))"
  Q "DELETE FROM wa_messages   WHERE id_kunjungan IN (SELECT id_kunjungan FROM tamdes_kunjungan WHERE id_user IN ($TESTSEL))"
  Q "DELETE FROM wa_sessions   WHERE id_kunjungan IN (SELECT id_kunjungan FROM tamdes_kunjungan WHERE id_user IN ($TESTSEL))"
  Q "DELETE FROM tamdes_kunjungan WHERE id_user IN ($TESTSEL)"
  Q "DELETE FROM tamdes_buku WHERE notel LIKE '0888399%' AND nama LIKE 'Uji Verif%'"
  Q "DELETE FROM wa_outbox WHERE phone_raw LIKE '0888399%' OR phone_raw LIKE '62888399%'"
  Q "DELETE FROM wa_outbox WHERE msg_type='verif_request' AND status='pending' AND body LIKE '%Data uji%'"
  echo "cleanup done"
}
trap cleanup EXIT

echo "########## VERIFIKASI E2E ##########"

echo "── Group G: read/role gates ──"
ok "G1 GET /api/deliveries no-auth -> 401" "401" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/deliveries")"
ok "G2 read as resepsionis -> 403"        "403" "$(CC "$(reqj GET /api/deliveries "$RESEP" "")")"
ok "G3 read as verifikator -> 200"        "200" "$(CC "$(reqj GET /api/deliveries "$HAL" "")")"
ok "G4 read as petugas_pst -> 200"        "200" "$(CC "$(reqj GET /api/deliveries "$PST" "")")"

V1=$(mkvisit 11 1); V2=$(mkvisit 12 1); V3=$(mkvisit 13 1); V5=$(mkvisit 15 0); V6=$(mkvisit 16 1)

echo "── Group C: create gates ──"
ok "C1 create as resepsionis -> 403" "403" "$(CC "$(reqf POST /api/deliveries "$RESEP" "id_kunjungan=$V1" "link_url=https://x.test/a")")"
ok "C2 create with neither link nor file -> 422" "422" "$(CC "$(reqf POST /api/deliveries "$PST" "id_kunjungan=$V1")")"

echo "── C3: create link-only + verifier notification ──"
R=$(reqf POST /api/deliveries "$PST" "id_kunjungan=$V1" "link_url=https://drive.test/data1" "note=Data uji 1"); B=$(BB "$R")
D1=$(jval "$B" id); SC1=$(jstr "$B" short_code)
ok  "C3 create -> 201" "201" "$(CC "$R")"
okc "C3 status menunggu_verifikasi" "menunggu_verifikasi" "$B"
ok  "C3 short_code = V<id>" "V$D1" "$SC1"
ok  "C3 verif_request enqueued" "1" "$(Q "SELECT COUNT(*) FROM wa_outbox WHERE id=(SELECT verif_outbox_id FROM data_deliveries WHERE id=$D1) AND msg_type='verif_request'")"
okc "C3 notif addressed to formatted @c.us jid" "6285159170808@c.us" "$(Q "SELECT wa_chat_id FROM wa_outbox WHERE id=(SELECT verif_outbox_id FROM data_deliveries WHERE id=$D1)")"
killverif $D1

echo "── Group V: verify decisions ──"
ok "V0 verify as petugas_pst -> 403" "403" "$(CC "$(reqj PUT /api/deliveries/$D1/verify "$PST" '{"decision":"setuju"}')")"
R=$(reqj PUT /api/deliveries/$D1/verify "$HAL" '{"decision":"setuju"}')
ok  "V1 setuju -> 200" "200" "$(CC "$R")"
ok  "V1 status terkirim" "terkirim" "$(Q "SELECT status FROM data_deliveries WHERE id=$D1")"
ok  "V1 customer message materialized" "1" "$(Q "SELECT COUNT(*) FROM wa_messages WHERE id_kunjungan=$V1 AND direction='out'")"
okc "V1 formal customer template" "Berikut data yang Bapak/Ibu minta" "$(Q "SELECT body FROM wa_messages WHERE id_kunjungan=$V1 AND direction='out' ORDER BY id DESC LIMIT 1")"

R=$(reqf POST /api/deliveries "$PST" "id_kunjungan=$V2" "link_url=https://drive.test/data2" "note=Data uji 2"); D2=$(jval "$(BB "$R")" id); killverif $D2
R=$(reqj PUT /api/deliveries/$D2/verify "$HAL" '{"decision":"setuju_catatan","note":"Data sementara, update bulan depan"}')
ok  "V2 setuju_catatan -> 200" "200" "$(CC "$R")"
ok  "V2 status terkirim" "terkirim" "$(Q "SELECT status FROM data_deliveries WHERE id=$D2")"
okc "V2 verifier note shown to customer" "Catatan: Data sementara" "$(Q "SELECT body FROM wa_messages WHERE id_kunjungan=$V2 AND direction='out' ORDER BY id DESC LIMIT 1")"

R=$(reqf POST /api/deliveries "$PST" "id_kunjungan=$V3" "link_url=https://drive.test/data3" "note=Data uji 3"); D3=$(jval "$(BB "$R")" id); killverif $D3
ok "V3a revisi without note -> 422" "422" "$(CC "$(reqj PUT /api/deliveries/$D3/verify "$HAL" '{"decision":"revisi"}')")"
R=$(reqj PUT /api/deliveries/$D3/verify "$HAL" '{"decision":"revisi","note":"Tahun 2023 belum ada"}')
ok "V3b revisi -> 200" "200" "$(CC "$R")"
ok "V3b status revisi" "revisi" "$(Q "SELECT status FROM data_deliveries WHERE id=$D3")"
ok "V3b NO customer message on revisi" "0" "$(Q "SELECT COUNT(*) FROM wa_messages WHERE id_kunjungan=$V3 AND direction='out'")"
R=$(reqf POST /api/deliveries/$D3/resubmit "$PST" "link_url=https://drive.test/data3-fix" "note=Sudah diperbaiki"); killverif $D3
ok "V3c resubmit -> 200" "200" "$(CC "$R")"
ok "V3c back to menunggu_verifikasi" "menunggu_verifikasi" "$(Q "SELECT status FROM data_deliveries WHERE id=$D3")"
ok "V3c revisi_count incremented" "1" "$(Q "SELECT revisi_count FROM data_deliveries WHERE id=$D3")"

echo "── Group X: conflict / validation / not-found ──"
ok "X1 re-verify already-terkirim -> 409 (no double-send)" "409" "$(CC "$(reqj PUT /api/deliveries/$D1/verify "$HAL" '{"decision":"setuju"}')")"
ok "X1 still exactly 1 customer message" "1" "$(Q "SELECT COUNT(*) FROM wa_messages WHERE id_kunjungan=$V1 AND direction='out'")"
ok "X2 invalid decision -> 422" "422" "$(CC "$(reqj PUT /api/deliveries/$D2/verify "$HAL" '{"decision":"foo"}')")"
ok "X3 verify non-existent id -> 404" "404" "$(CC "$(reqj PUT /api/deliveries/99999999/verify "$HAL" '{"decision":"setuju"}')")"

echo "── Group S: approved-but-no-customer-address (send-failed) ──"
R=$(reqf POST /api/deliveries "$PST" "id_kunjungan=$V5" "link_url=https://drive.test/data5" "note=Data uji 5"); D5=$(jval "$(BB "$R")" id); killverif $D5
R=$(reqj PUT /api/deliveries/$D5/verify "$HAL" '{"decision":"setuju"}')
ok  "S1 setuju (no wa_session) -> 200" "200" "$(CC "$R")"
ok  "S1 status disetujui (NOT terkirim)" "disetujui" "$(Q "SELECT status FROM data_deliveries WHERE id=$D5")"
ok  "S1 NO customer message created" "0" "$(Q "SELECT COUNT(*) FROM wa_messages WHERE id_kunjungan=$V5 AND direction='out'")"
okc "S1 message warns belum terkirim" "belum terkirim" "$(BB "$R")"

echo "── Group K: cancel ──"
R=$(reqf POST /api/deliveries "$PST" "id_kunjungan=$V6" "link_url=https://drive.test/data6"); D6=$(jval "$(BB "$R")" id); killverif $D6
ok "K1 cancel as resepsionis -> 403" "403" "$(CC "$(reqj DELETE /api/deliveries/$D6 "$RESEP" "")")"
ok "K2 cancel pending -> 200" "200" "$(CC "$(reqj DELETE /api/deliveries/$D6 "$PST" "")")"
ok "K2 status dibatalkan" "dibatalkan" "$(Q "SELECT status FROM data_deliveries WHERE id=$D6")"
ok "K3 cancel a terkirim delivery -> 409" "409" "$(CC "$(reqj DELETE /api/deliveries/$D1 "$PST" "")")"

echo "########## RESULT: PASS=$PASS FAIL=$FAIL ##########"
