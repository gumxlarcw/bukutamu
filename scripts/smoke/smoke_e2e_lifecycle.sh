#!/bin/bash
# Live E2E smoke — visit LIFECYCLE & finalization gates (auth-gated; the security invariants).
# Mints short-lived test JWT/kiosk tokens from backend/.env (localhost only). Test namespace
# 0888399*; full cleanup incl. audit rows. Does NOT call the TV /call endpoint (real dashboard).
set -u
BASE='http://127.0.0.1:60'
SC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then echo "  PASS: $1"; PASS=$((PASS+1)); else echo "  FAIL: $1 — expected [$2] got [$3]"; FAIL=$((FAIL+1)); fi; }
okc(){ if echo "$3" | grep -qF "$2"; then echo "  PASS: $1"; PASS=$((PASS+1)); else echo "  FAIL: $1 — lacks [$2]: ${3:0:140}"; FAIL=$((FAIL+1)); fi; }
Q(){ mysql -N db_tamdes -e "$1" 2>/dev/null; }
PST=$(php "$SC/mintjwt.php" 7 wisnu petugas_pst)
RESEP=$(php "$SC/mintjwt.php" 2 nayla resepsionis)
SUP=$(php "$SC/mintjwt.php" 1 admin superadmin)
reqj(){ local m=$1 u=$2 t=$3 d=$4; local a=(-s -w $'\n%{http_code}' -X "$m" "$BASE$u" -H 'Content-Type: application/json' --cookie "jwt_token=$t"); [ -n "$d" ] && a+=(-d "$d"); curl "${a[@]}"; }
reqk(){ local m=$1 u=$2 t=$3 d=$4; local a=(-s -w $'\n%{http_code}' -X "$m" "$BASE$u" -H 'Content-Type: application/json' -H "X-Kiosk-Token: $t"); [ -n "$d" ] && a+=(-d "$d"); curl "${a[@]}"; }
CC(){ echo "${1##*$'\n'}"; }
BB(){ echo "${1%$'\n'*}"; }
IDKS=""; GUS=""
mkvisit(){ # seq service sarana status -> echo "idk uid"
  local seq=$1 svc=$2 sr=$3 st=$4
  local MX=$(Q "SELECT MAX(id_user) FROM tamdes_buku"); local U=$((MX+1))
  Q "INSERT INTO tamdes_buku (id_user,nama,notel,registered_via,tgldatang) VALUES ($U,'Uji LC $seq','0888399$seq','kiosk',CURDATE())"
  Q "INSERT INTO tamdes_kunjungan (id_user,jenis_layanan,sarana,date_visit,status,created_by) VALUES ($U,JSON_ARRAY('$svc'),JSON_ARRAY($sr),NOW(),'$st','kiosk')"
  local IDK=$(Q "SELECT id_kunjungan FROM tamdes_kunjungan WHERE id_user=$U ORDER BY id_kunjungan DESC LIMIT 1")
  IDKS="$IDKS,$IDK"; GUS="$GUS,$U"
  echo "$IDK $U"
}
mkkonsul(){ Q "INSERT INTO konsultasi_pengunjung (id_kunjungan,rincian_data,status_data,hasil_konsultasi) VALUES ($1,'X',1,'ok')"; }
mkdtsen(){ Q "INSERT INTO dtsen_konsultasi (id_kunjungan,jenis_konsultasi_dtsen,hasil,tanggal_input) VALUES ($1,1,1,NOW())"; }
# Eval body: validation only needs skor 1-10 + kepuasan as an array (may be empty). The
# status-eligibility gate runs AFTER this, so a valid body is needed to reach the gate.
EVB='{"skor_keseluruhan":9,"kepuasan":{}}'

echo "########## GROUP L: finalization gates (the SKD security invariant) ##########"
read I1 _ <<< "$(mkvisit 60 'Konsultasi Statistik' 2 antri)"; mkkonsul $I1
R=$(reqj PUT /api/visits/$I1/status "$PST" '{"status":"selesai"}')
ok "L1 PUT selesai accepted (200)" "200" "$(CC "$R")"
ok "L1 SKD soft-corrected to menunggu_evaluasi (NOT selesai)" "menunggu_evaluasi" "$(Q "SELECT status FROM tamdes_kunjungan WHERE id_kunjungan=$I1")"

read I2 _ <<< "$(mkvisit 61 'Konsultasi Statistik' 2 antri)"   # no konsul row
R=$(reqj PUT /api/visits/$I2/status "$PST" '{"status":"selesai"}')
ok "L2 SKD form gate -> 400" "400" "$(CC "$R")"; okc "L2 msg" "Form konsultasi SKD belum lengkap" "$(BB "$R")"

read I3 _ <<< "$(mkvisit 62 'Konsultasi Statistik' 2 antri)"; mkkonsul $I3
R=$(reqj PUT /api/visits/$I3/status "$RESEP" '{"status":"selesai"}')
ok "L3 resepsionis cannot finalize SKD -> 403" "403" "$(CC "$R")"; okc "L3 msg" "hanya bisa diselesaikan oleh" "$(BB "$R")"

read I4 _ <<< "$(mkvisit 63 'Konsultasi Statistik' 2 antri)"; mkkonsul $I4
R=$(reqj PUT /api/visits/$I4/status "$SUP" '{"status":"selesai"}')
ok "L4 superadmin BYPASS -> selesai directly" "selesai" "$(Q "SELECT status FROM tamdes_kunjungan WHERE id_kunjungan=$I4")"

read I5 _ <<< "$(mkvisit 64 'Konsultasi DTSEN' 1 antri)"; mkdtsen $I5
R=$(reqj PUT /api/dtsen/$I5 "$PST" '{"status":"selesai"}')
ok "L5 DTSEN finishes directly (200)" "200" "$(CC "$R")"
ok "L5 DTSEN -> selesai (NOT menunggu_evaluasi)" "selesai" "$(Q "SELECT status FROM tamdes_kunjungan WHERE id_kunjungan=$I5")"

read I6 _ <<< "$(mkvisit 65 'Konsultasi DTSEN' 1 antri)"   # no dtsen row
R=$(reqj PUT /api/dtsen/$I6 "$PST" '{"status":"selesai"}')
ok "L6 DTSEN form gate -> 400" "400" "$(CC "$R")"; okc "L6 msg" "Form DTSEN belum diisi" "$(BB "$R")"

read I7 _ <<< "$(mkvisit 66 'Konsultasi Statistik' 2 antri)"; mkkonsul $I7
R=$(reqj PUT /api/consultations/$I7 "$PST" '{"status":"selesai"}')
ok "L7 Consultations endpoint same gate (soft-correct, no bypass-by-endpoint)" "menunggu_evaluasi" "$(Q "SELECT status FROM tamdes_kunjungan WHERE id_kunjungan=$I7")"

echo "########## GROUP E: tablet evaluation gate ##########"
read E1 _ <<< "$(mkvisit 67 'Konsultasi Statistik' 2 antri)"; mkkonsul $E1
KT1=$(php "$SC/mintkiosk.php" eval-submit $E1 600)
R=$(reqk POST /api/evaluations/$E1 "$KT1" "$EVB")
ok "E1 eval on ineligible (antri) -> 400" "400" "$(CC "$R")"; okc "E1 msg" "Evaluasi belum tersedia" "$(BB "$R")"

read E2 _ <<< "$(mkvisit 68 'Konsultasi Statistik' 2 menunggu_evaluasi)"; mkkonsul $E2
KT2=$(php "$SC/mintkiosk.php" eval-submit $E2 600)
R=$(reqk POST /api/evaluations/$E2 "$KT2" "$EVB")
ok "E2 eval on eligible visit -> 200" "200" "$(CC "$R")"; okc "E2 msg" "Evaluasi berhasil disimpan" "$(BB "$R")"
ok "E2 visit -> selesai after eval (kiosk-origin)" "selesai" "$(Q "SELECT status FROM tamdes_kunjungan WHERE id_kunjungan=$E2")"

echo "########## GROUP D: admin delete cascade + guest-delete refuse ##########"
read D1 _ <<< "$(mkvisit 70 'Konsultasi Statistik' 2 selesai)"; mkkonsul $D1
R=$(reqj DELETE /api/visits/$D1 "$SUP" '')
ok "D1 admin delete visit -> 200" "200" "$(CC "$R")"; okc "D1 msg" "berhasil dihapus" "$(BB "$R")"
ok "D1 visit row gone" "0" "$(Q "SELECT COUNT(*) FROM tamdes_kunjungan WHERE id_kunjungan=$D1")"
ok "D1 konsultasi child cascaded" "0" "$(Q "SELECT COUNT(*) FROM konsultasi_pengunjung WHERE id_kunjungan=$D1")"
ok "D1 audit row written" "1" "$(Q "SELECT COUNT(*) FROM tamdes_audit_log WHERE target_type='visit' AND target_id=$D1 AND action='delete'")"

read D2 _ <<< "$(mkvisit 71 'Konsultasi Statistik' 2 selesai)"
R=$(reqj DELETE /api/visits/$D2 "$PST" '')
ok "D2 petugas_pst cannot delete visit -> 403" "403" "$(CC "$R")"

read D3 U3 <<< "$(mkvisit 72 'Konsultasi Statistik' 2 antri)"
R=$(reqj DELETE /api/guests/$U3 "$SUP" '')
ok "D3 guest-delete-with-visits refused -> 409" "409" "$(CC "$R")"; okc "D3 msg" "masih punya" "$(BB "$R")"

MXG=$(Q "SELECT MAX(id_user) FROM tamdes_buku"); U4=$((MXG+1)); GUS="$GUS,$U4"
Q "INSERT INTO tamdes_buku (id_user,nama,notel,registered_via,tgldatang) VALUES ($U4,'Uji LC 73','0888399973','kiosk',CURDATE())"
R=$(reqj DELETE /api/guests/$U4 "$SUP" '')
ok "D4 guest-delete (no visits) -> 200" "200" "$(CC "$R")"; okc "D4 msg" "berhasil dihapus" "$(BB "$R")"

echo "########## CLEANUP ##########"
# mkvisit's accumulators are lost (subshell), so clean from parent-scope vars + the notel
# namespace. Audit rows for API-deleted visit (D1) / guest (D4) are cleaned by their captured ids.
AUDIT_VIDS="$I1,$I2,$I3,$I4,$I5,$I6,$I7,$E1,$E2,$D1,$D2,$D3"
AUDIT_GIDS="$U3,$U4"
ALLU=$(Q "SELECT GROUP_CONCAT(id_user) FROM tamdes_buku WHERE notel LIKE '0888399%'"); [ -z "$ALLU" ] && ALLU=0
VIDS=$(Q "SELECT IFNULL(GROUP_CONCAT(id_kunjungan),0) FROM tamdes_kunjungan WHERE id_user IN ($ALLU)")
Q "DELETE FROM konsultasi_pengunjung WHERE id_kunjungan IN ($VIDS)"
Q "DELETE FROM dtsen_konsultasi WHERE id_kunjungan IN ($VIDS)"
Q "DELETE FROM tamdes_evaluasi_detail WHERE id_kunjungan IN ($VIDS)"
Q "DELETE FROM tamdes_audit_log WHERE target_type='visit' AND target_id IN ($AUDIT_VIDS)"
Q "DELETE FROM tamdes_audit_log WHERE target_type='guest' AND target_id IN ($AUDIT_GIDS)"
Q "DELETE FROM tamdes_kunjungan WHERE id_user IN ($ALLU)"
Q "DELETE FROM tamdes_buku WHERE id_user IN ($ALLU)"
ok "no test guests left" "0" "$(Q "SELECT COUNT(*) FROM tamdes_buku WHERE notel LIKE '0888399%'")"
ok "no test visits left" "0" "$(Q "SELECT COUNT(*) FROM tamdes_kunjungan WHERE id_user IN ($ALLU)")"

echo
echo "===================== E2E LIFECYCLE SMOKE: $PASS passed, $FAIL failed ====================="
