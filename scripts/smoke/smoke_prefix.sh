#!/bin/bash
# Live focused smoke — queue-prefix collision fix (Perpustakaan=P vs Penjualan Produk Statistik=J).
# Uses WA #2 offline path (unauthenticated) which calls generate_queue_number.
# Safety: fake group + fake phones (62888399xxx, never real) + prompt outbox delete + full cleanup.
set -u
BASE='http://127.0.0.1:60'
PUSH=/var/www/html/bukutamu/backend/application/config/push.php
SECRET=$(grep -oP "push_internal_secret'\]\s*=\s*'\K[^']+" "$PUSH")
FAKE_GROUP='000000000-000000000@g.us'
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then echo "  PASS: $1"; PASS=$((PASS+1)); else echo "  FAIL: $1 — expected [$2] got [$3]"; FAIL=$((FAIL+1)); fi; }
okp(){ local pre="${3:0:1}"; if [ "$pre" = "$2" ]; then echo "  PASS: $1 ($3)"; PASS=$((PASS+1)); else echo "  FAIL: $1 — expected prefix [$2] got [$3]"; FAIL=$((FAIL+1)); fi; }
Q(){ mysql -N db_tamdes -e "$1"; }
ING(){ curl -s -X POST $BASE/api/wa/ingest -H "X-Internal-Secret: $SECRET" -H 'Content-Type: application/json' -d "{\"phone\":\"$1\",\"wa_id\":\"$1@c.us\",\"text\":\"$2\"}" >/dev/null; }
TOK(){ Q "SELECT body FROM wa_outbox WHERE phone_raw='$1' AND msg_type='intake_link' ORDER BY id DESC LIMIT 1" | grep -oP 't=\K[A-Za-z0-9._-]+' | head -1; }
SID(){ Q "SELECT id FROM wa_sessions WHERE phone_norm='$1' ORDER BY id DESC LIMIT 1"; }

# --- save & set fake group ---
ORIG_GROUP=$(grep -oP "wa_notify_group'\]\s*=\s*'\K[^']*" "$PUSH")
cp "$PUSH" "$PUSH.smokebak"
sed -i "s#\(\$config\['wa_notify_group'\]\s*=\s*'\)[^']*#\1$FAKE_GROUP#" "$PUSH"
echo "group: orig=[$ORIG_GROUP] now=[$(grep -oP "wa_notify_group'\]\s*=\s*'\K[^']*" "$PUSH")]"

P1=62888399001; N1=0888399001   # Penjualan Produk Statistik  -> J
P2=62888399002; N2=0888399002   # Perpustakaan                -> P
P3=62888399003; N3=0888399003   # Penjualan Produk Statistik  -> J (sequential)

mk_offline(){ # phone norm jenis sarana -> echo id_kunjungan
  local P=$1 N=$2 JL=$3 SR=$4
  ING $P halo; ING $P 2
  local s=$(SID $N) t=$(TOK $P)
  curl -s -X POST "$BASE/api/wa/session/$s" -H "X-Kiosk-Token: $t" -H 'Content-Type: application/json' \
    -d "{\"nama\":\"Uji Prefix $N\",\"notel\":\"$P\",\"jenis_layanan\":[\"$JL\"],\"sarana\":[$SR],\"permintaan\":[]}" >/dev/null
  # prompt-delete user-directed outbox (fake number) to avoid connector send attempt
  Q "DELETE FROM wa_outbox WHERE phone_raw='$P'"
  Q "SELECT id_kunjungan FROM wa_sessions WHERE phone_norm='$N'"
}

echo "===== create 3 #2 visits ====="
IDK1=$(mk_offline $P1 $N1 "Penjualan Produk Statistik" 2)
IDK2=$(mk_offline $P2 $N2 "Perpustakaan" 2)
IDK3=$(mk_offline $P3 $N3 "Penjualan Produk Statistik" 2)
NO1=$(Q "SELECT IFNULL(nomor_antrian,'') FROM tamdes_kunjungan WHERE id_kunjungan=$IDK1")
NO2=$(Q "SELECT IFNULL(nomor_antrian,'') FROM tamdes_kunjungan WHERE id_kunjungan=$IDK2")
NO3=$(Q "SELECT IFNULL(nomor_antrian,'') FROM tamdes_kunjungan WHERE id_kunjungan=$IDK3")
echo "  Penjualan#1=$NO1  Perpustakaan=$NO2  Penjualan#2=$NO3"

echo "===== assertions ====="
okp "Penjualan Produk Statistik gets 'J' prefix (NOT 'P')" "J" "$NO1"
okp "Perpustakaan keeps 'P' prefix" "P" "$NO2"
okp "2nd Penjualan also 'J'" "J" "$NO3"
ok  "Penjualan & Perpustakaan numbers DISTINCT (collision fixed)" "yes" "$([ "$NO1" != "$NO2" ] && echo yes || echo no)"
# sequential within Penjualan's own counter (today started at 0 → J001, J002)
ok  "Penjualan sequential (its own counter)" "yes" "$([ "${NO1:1}" -lt "${NO3:1}" ] 2>/dev/null && echo yes || echo no)"

echo "===== cleanup ====="
for idk in $IDK1 $IDK2 $IDK3; do
  IDU=$(Q "SELECT id_user FROM tamdes_kunjungan WHERE id_kunjungan=$idk")
  Q "DELETE FROM tamdes_kunjungan WHERE id_kunjungan=$idk"
  # delete the test guest only if it's one of ours (test notel, stored NORMALIZED 0888399*)
  # and it has no other visits. NB: notel is the normalized form, never the raw 62* form.
  Q "DELETE FROM tamdes_buku WHERE id_user=$IDU AND notel LIKE '0888399%' AND NOT EXISTS (SELECT 1 FROM tamdes_kunjungan k WHERE k.id_user=$IDU)"
  Q "DELETE FROM wa_outbox WHERE id_kunjungan=$idk"
done
# user-directed (phone_raw raw 62*) AND group_notify (wa_chat_id = fake group, no id_kunjungan)
Q "DELETE FROM wa_outbox WHERE phone_raw IN ('$P1','$P2','$P3') OR phone_raw LIKE '0888399%' OR wa_chat_id='$FAKE_GROUP'"
Q "DELETE FROM wa_sessions WHERE phone_norm IN ('$N1','$N2','$N3')"

# --- restore group ---
mv "$PUSH.smokebak" "$PUSH"
RG=$(grep -oP "wa_notify_group'\]\s*=\s*'\K[^']*" "$PUSH")
ok "group restored" "$ORIG_GROUP" "$RG"

echo "===== residual check (must all be 0) ====="
ok "no test sessions"   "0" "$(Q "SELECT COUNT(*) FROM wa_sessions WHERE phone_norm IN ('$N1','$N2','$N3')")"
ok "no test guests"     "0" "$(Q "SELECT COUNT(*) FROM tamdes_buku WHERE notel LIKE '0888399%'")"
ok "no test outbox"     "0" "$(Q "SELECT COUNT(*) FROM wa_outbox WHERE phone_raw LIKE '0888399%' OR phone_raw IN ('$P1','$P2','$P3') OR wa_chat_id='$FAKE_GROUP'")"
ok "no test visits"     "0" "$(Q "SELECT COUNT(*) FROM tamdes_kunjungan WHERE id_kunjungan IN ($IDK1,$IDK2,$IDK3)")"

echo
echo "===================== PREFIX SMOKE: $PASS passed, $FAIL failed ====================="
