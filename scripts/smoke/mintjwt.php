<?php
// Mint a JWT exactly like backend JWT_Helper (HS256, secret from backend/.env). Test-only, localhost.
$secret = '';
foreach (file('/var/www/html/bukutamu/backend/.env', FILE_IGNORE_NEW_LINES|FILE_SKIP_EMPTY_LINES) as $l) {
  if (strpos(trim($l), 'JWT_SECRET=') === 0) { $secret = trim(substr(trim($l), 11)); break; }
}
function b64u($d){ return rtrim(strtr(base64_encode($d), '+/', '-_'), '='); }
$h = b64u(json_encode(['typ'=>'JWT','alg'=>'HS256']));
$p = b64u(json_encode(['id'=>(int)$argv[1],'username'=>$argv[2],'nama'=>$argv[2],'role'=>$argv[3],'iat'=>time(),'exp'=>time()+3600]));
echo "$h.$p." . b64u(hash_hmac('sha256', "$h.$p", $secret, true));
