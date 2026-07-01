<?php
defined('BASEPATH') OR exit('No direct script access allowed');

/*
| -------------------------------------------------------------------------
| URI ROUTING
| -------------------------------------------------------------------------
| Bukutamu backend is JSON-API only. The legacy CI3 HMVC web modules
| (admin, layanan, recognize, selamat_datang) and the top-level Evaluasi
| controller were deleted on 2026-05-17 — the React SPA replaces them.
| Apache vhost routes /api/* and /index.php to this app; everything else
| goes to the React SPA at 127.0.0.1:3060.
| -------------------------------------------------------------------------
*/

// No default web controller. /index.php with no path returns a clean 404
// (legacy default 'selamat_datang' is gone). The new React SPA owns / on
// the public URL.
$route['default_controller'] = '';
$route['404_override']       = '';
$route['translate_uri_dashes'] = FALSE;

// ── API Routes ──────────────────────────────────────────────────────────
$route['api/auth/check']  = 'api/auth/check';
$route['api/auth/login']  = 'api/auth/login';
$route['api/auth/logout'] = 'api/auth/logout';

$route['api/guests']                  = 'api/guests/index';
$route['api/guests/(:num)']           = 'api/guests/detail/$1';
$route['api/guests/(:num)/visits']    = 'api/guests/visits/$1';
$route['api/guests/(:num)/photo']     = 'api/guests/photo/$1';

$route['api/visits']                  = 'api/visits/index';
$route['api/visits/(:num)']           = 'api/visits/detail/$1';
$route['api/visits/(:num)/status']    = 'api/visits/status/$1';
$route['api/visits/(:num)/service']   = 'api/visits/service/$1';
$route['api/visits/(:num)/summary']   = 'api/visits/summary/$1';

$route['api/consultations']                       = 'api/consultations/index';
$route['api/consultations/(:num)/call']           = 'api/consultations/call/$1';
$route['api/consultations/(:num)/test-sound']     = 'api/consultations/test_sound/$1';
$route['api/consultations/(:num)/data']           = 'api/consultations/data/$1';
$route['api/consultations/(:num)']                = 'api/consultations/detail/$1';

$route['api/dtsen']                    = 'api/dtsen/index';
$route['api/dtsen/(:num)/data']        = 'api/dtsen/data/$1';
$route['api/dtsen/(:num)']             = 'api/dtsen/detail/$1';

$route['api/evaluations/pending']        = 'api/evaluations/pending';
$route['api/evaluations/pending-list']   = 'api/evaluations/pending_list';
$route['api/evaluations/summary']        = 'api/evaluations/summary';
$route['api/evaluations/(:num)/results'] = 'api/evaluations/results/$1';
$route['api/evaluations/(:num)']         = 'api/evaluations/detail/$1';

$route['api/responden/visit/(:num)']   = 'api/responden/visit_detail/$1';
$route['api/responden/export']         = 'api/responden/export';
$route['api/responden']                = 'api/responden/index';

$route['api/users']                    = 'api/users/index';
$route['api/users/change-password']    = 'api/users/change_password';
$route['api/users/(:num)']             = 'api/users/detail/$1';

$route['api/audit']                    = 'api/audit/index';
$route['api/queue-stats']              = 'api/queue_stats/index';
$route['api/notifications']            = 'api/notifications/index';
$route['api/notifications/dispatch']   = 'api/notifications/dispatch';

// Web Push (Tier-2 desktop notifications)
$route['api/push/vapid']               = 'api/push/vapid';
$route['api/push/subscribe']           = 'api/push/subscribe';
$route['api/push/unsubscribe']         = 'api/push/unsubscribe';
$route['api/push/prune']               = 'api/push/prune';

$route['api/dashboard/stats']          = 'api/dashboard/stats';
$route['api/dashboard/events']         = 'api/dashboard/events';

$route['api/services']                 = 'api/services/index';

$route['api/kiosk/face-data']                = 'api/kiosk/face_data';
$route['api/kiosk/guest-list']               = 'api/kiosk/guest_list';
$route['api/kiosk/register']                 = 'api/kiosk/register';
$route['api/kiosk/visit']                    = 'api/kiosk/visit';
$route['api/kiosk/ticket/(:num)']            = 'api/kiosk/ticket/$1';
$route['api/kiosk/profile-gaps/(:num)']      = 'api/kiosk/profile_gaps/$1';
$route['api/kiosk/profile-update/(:num)']    = 'api/kiosk/profile_update/$1';
$route['api/kiosk/wa-lookup']                = 'api/kiosk/wa_lookup';    // POST find WA online registrant by phone (kiosk check-in)
$route['api/kiosk/wa-promote']               = 'api/kiosk/wa_promote';   // POST enroll face + promote WA visit to physical queue

// Data deliveries (verifikator flow) — specific paths before generic
$route['api/deliveries']                 = 'api/deliveries/index';
$route['api/deliveries/(:num)/file']     = 'api/deliveries/file/$1';
$route['api/deliveries/(:num)/verify']   = 'api/deliveries/verify/$1';
$route['api/deliveries/(:num)/resubmit'] = 'api/deliveries/resubmit/$1';
$route['api/deliveries/(:num)']          = 'api/deliveries/detail/$1';

// WhatsApp online data-request channel (api/wa/*)
$route['api/wa/ingest']          = 'api/wa/ingest';        // POST internal-secret
$route['api/wa/poll']            = 'api/wa/poll';          // POST internal-secret (dispatch scan + pending)
$route['api/wa/ack']             = 'api/wa/ack';           // POST internal-secret
$route['api/wa/inbox']           = 'api/wa/inbox';         // GET  admin (Layanan Online list)
$route['api/wa/session/(:num)']  = 'api/wa/session/$1';    // GET prefill / POST submit (kiosk-token wa-intake)
$route['api/wa/eval/(:num)']     = 'api/wa/eval_access/$1';// GET  exchange wa-eval-access -> eval-submit
$route['api/wa/qr-state']      = 'api/wa/qr_state';
$route['api/wa/disconnect']     = 'api/wa/disconnect';
$route['api/wa/pair']           = 'api/wa/pair';            // POST auth+PST (link with phone number → pairing code)
// Live chat (web petugas ↔ WhatsApp) — specific paths BEFORE the generic 'messages'.
$route['api/wa/chat-ingest']     = 'api/wa/chat_ingest';     // POST internal-secret (inbound store)
$route['api/wa/messages/upload']   = 'api/wa/messages_upload';   // POST auth+PST (outbound media)
$route['api/wa/messages/fail']     = 'api/wa/messages_fail';     // POST internal-secret (mark failed)
$route['api/wa/messages/backfill'] = 'api/wa/messages_backfill'; // POST auth+PST (enqueue history backfill)
$route['api/wa/backfill-active']   = 'api/wa/backfill_active';   // POST internal-secret (reconnect/outage recovery)
$route['api/wa/messages']        = 'api/wa/messages';        // GET thread / POST send text (auth+PST)
$route['api/wa/seen']            = 'api/wa/seen';            // POST mark-seen (auth+PST → connector sendSeen)
$route['api/wa/react']           = 'api/wa/react';           // POST react emoji to a message (auth+PST)
$route['api/wa/media/(:num)']    = 'api/wa/media/$1';        // GET media stream (auth+PST)
$route['api/wa/sessions/(:num)/assign'] = 'api/wa/session_assign/$1'; // POST take-over (auth+PST)
$route['api/wa/sessions/(:num)/send-data-form'] = 'api/wa/send_data_form/$1'; // POST petugas → kirim form Permintaan Data (auth+PST)
$route['api/wa/sessions/(:num)'] = 'api/wa/session_delete/$1'; // DELETE pending session (admin only)
$route['api/wa/visits/(:num)/proses'] = 'api/wa/visit_proses/$1'; // POST mark visit 'diproses' (auth+PST)
$route['api/wa/visits/(:num)/selesai'] = 'api/wa/visit_selesai/$1'; // POST manual close (evaluasi_selesai → selesai)
