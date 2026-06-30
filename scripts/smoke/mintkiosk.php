<?php
$secret='';
foreach(file('/var/www/html/bukutamu/backend/.env',FILE_IGNORE_NEW_LINES|FILE_SKIP_EMPTY_LINES) as $l){
  if(strpos(trim($l),'JWT_SECRET=')===0){$secret=trim(substr(trim($l),11));break;}
}
$payload=$argv[1].'.'.$argv[2].'.'.(time()+(isset($argv[3])?(int)$argv[3]:600));
echo $payload.'.'.rtrim(strtr(base64_encode(hash_hmac('sha256',$payload,$secret,true)),'+/','-_'),'=');
