<?php
defined('BASEPATH') OR exit('No direct script access allowed');

require_once APPPATH . 'modules/api/controllers/Api_base.php';

/**
 * Web Push subscription management (Tier-2 desktop notifications).
 *
 * - vapid()       : GET  public VAPID key (browser needs it to subscribe).
 * - subscribe()   : POST store/refresh a PushSubscription, bound to the
 *                   authenticated user's role (the notifier targets by role).
 * - unsubscribe() : POST remove a subscription by endpoint (on logout).
 * - prune()       : POST [internal] remove dead endpoints (410/404) reported
 *                   by the notifier service.
 *
 * Actual push SENDING lives in the Node `notifier/` service; the per-role feed
 * it consumes is Notifications::dispatch(). VAPID keys + internal secret are in
 * the git-ignored config/push.php (read via Api_base::push_config()).
 */
class Push extends Api_base {

    public function vapid() {
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }
        $pub = $this->push_config('push_vapid_public');
        if (!$pub) {
            $this->json_response(['success' => false, 'message' => 'Push not configured'], 503);
        }
        $this->json_response(['success' => true, 'data' => ['public_key' => $pub], 'message' => 'OK']);
    }

    public function subscribe() {
        $this->require_auth();
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        $input = $this->get_json_input();
        // Accept either the raw PushSubscription JSON or { subscription: {...} }.
        $sub = (isset($input['subscription']) && is_array($input['subscription'])) ? $input['subscription'] : $input;

        $endpoint = isset($sub['endpoint']) ? trim((string) $sub['endpoint']) : '';
        $p256dh   = isset($sub['keys']['p256dh']) ? (string) $sub['keys']['p256dh'] : '';
        $auth     = isset($sub['keys']['auth'])   ? (string) $sub['keys']['auth']   : '';

        if ($endpoint === '' || $p256dh === '' || $auth === '') {
            $this->json_response(['success' => false, 'message' => 'Subscription tidak lengkap (endpoint/keys).'], 400);
        }

        $role    = isset($this->current_user->role) ? $this->current_user->role : 'operator';
        $id_user = isset($this->current_user->id) ? (int) $this->current_user->id : null;
        $hash    = hash('sha256', $endpoint);
        $ua      = isset($_SERVER['HTTP_USER_AGENT']) ? substr((string) $_SERVER['HTTP_USER_AGENT'], 0, 255) : null;
        $now     = date('Y-m-d H:i:s');

        // Upsert by endpoint_hash — same browser re-subscribing just refreshes
        // keys/role/last_seen (e.g. after a VAPID rotation or role change).
        $existing = $this->db->get_where('push_subscriptions', ['endpoint_hash' => $hash])->row();
        if ($existing) {
            $this->db->where('endpoint_hash', $hash)->update('push_subscriptions', [
                'p256dh'       => $p256dh,
                'auth'         => $auth,
                'role'         => $role,
                'id_user'      => $id_user,
                'user_agent'   => $ua,
                'last_seen_at' => $now,
            ]);
        } else {
            $this->db->insert('push_subscriptions', [
                'endpoint'      => $endpoint,
                'endpoint_hash' => $hash,
                'p256dh'        => $p256dh,
                'auth'          => $auth,
                'role'          => $role,
                'id_user'       => $id_user,
                'user_agent'    => $ua,
                'created_at'    => $now,
                'last_seen_at'  => $now,
            ]);
        }

        $this->json_response(['success' => true, 'data' => null, 'message' => 'Subscription tersimpan']);
    }

    public function unsubscribe() {
        $this->require_auth();
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }
        $input    = $this->get_json_input();
        $endpoint = isset($input['endpoint']) ? trim((string) $input['endpoint']) : '';
        if ($endpoint === '') {
            $this->json_response(['success' => false, 'message' => 'endpoint diperlukan'], 400);
        }
        $this->db->where('endpoint_hash', hash('sha256', $endpoint))->delete('push_subscriptions');
        $this->json_response(['success' => true, 'data' => null, 'message' => 'Subscription dihapus']);
    }

    public function prune() {
        $this->require_internal_secret();
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }
        $input  = $this->get_json_input();
        $hashes = $input['endpoint_hashes'] ?? [];
        $clean  = is_array($hashes) ? array_values(array_filter($hashes, function ($h) {
            return is_string($h) && preg_match('/^[a-f0-9]{64}$/', $h);
        })) : [];
        if (count($clean) === 0) {
            $this->json_response(['success' => true, 'data' => ['deleted' => 0], 'message' => 'Nothing to prune']);
        }
        $this->db->where_in('endpoint_hash', $clean)->delete('push_subscriptions');
        $this->json_response(['success' => true, 'data' => ['deleted' => $this->db->affected_rows()], 'message' => 'Pruned']);
    }
}
