<?php
defined('BASEPATH') OR exit('No direct script access allowed');

class JWT_Helper {

    private $secret;
    private $expiry = 14400; // 4 hours

    public function __construct() {
        $secret = getenv('JWT_SECRET');
        if (!$secret || $secret === '') {
            // Try loading from .env directly
            $envFile = FCPATH . '.env';
            if (is_readable($envFile)) {
                foreach (file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                    if (strpos(trim($line), 'JWT_SECRET=') === 0) {
                        $secret = trim(substr(trim($line), 11));
                        break;
                    }
                }
            }
        }
        if (!$secret || strlen($secret) < 32) {
            // #12 — fail CLOSED: never substitute a path-derived secret (forgeable offline).
            // require_auth / require_kiosk_token return 503 when the secret is missing/short.
            log_message('error', 'JWT_SECRET not set or too short (<32). Auth disabled (fail-closed). Set a strong secret in .env');
            $this->secret = null;
            return;
        }
        $this->secret = $secret;
    }

    // #12 — auth gates check this; a null secret => fail closed (503), never a forgeable fallback.
    public function has_secret() {
        return $this->secret !== null;
    }

    public function encode($payload) {
        if ($this->secret === null) return null; // #12 fail-closed — no HMAC with a null key
        $header = $this->base64url_encode(json_encode(['typ' => 'JWT', 'alg' => 'HS256']));
        $payload['iat'] = time();
        $payload['exp'] = time() + $this->expiry;
        $payload_encoded = $this->base64url_encode(json_encode($payload));
        $signature = $this->base64url_encode(
            hash_hmac('sha256', "$header.$payload_encoded", $this->secret, true)
        );
        return "$header.$payload_encoded.$signature";
    }

    public function decode($token) {
        if ($this->secret === null) return null; // #12 fail-closed — no HMAC with a null key
        $parts = explode('.', $token);
        if (count($parts) !== 3) return null;
        list($header, $payload, $signature) = $parts;
        $valid_signature = $this->base64url_encode(
            hash_hmac('sha256', "$header.$payload", $this->secret, true)
        );
        if (!hash_equals($valid_signature, $signature)) return null;
        $data = json_decode($this->base64url_decode($payload));
        if (!$data || (isset($data->exp) && $data->exp < time())) return null;
        return $data;
    }

    private function base64url_encode($data) {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    private function base64url_decode($data) {
        return base64_decode(strtr($data, '-_', '+/'));
    }
}
