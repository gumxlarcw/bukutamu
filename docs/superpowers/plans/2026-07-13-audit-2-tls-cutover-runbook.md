# Audit #2 — TLS Cutover Runbook (do NOT auto-apply)

**Finding #2 (High):** admin login + `jwt_token` cookie are served over plaintext HTTP `:60` with no HTTPS redirect; `:460` uses a **self-signed** cert. Goal: force HTTPS, trusted cert, `Secure` cookie, HSTS — without locking anyone out or breaking the connectors.

**Why this is a deliberate cutover, not a live edit:**
- `Auth.php` is **live-on-save** (opcache revalidate 2s). Setting the cookie `secure` **before** HTTPS is enforced makes the browser refuse to send it over `:60` → **every `:60` login breaks instantly.** The cookie change must be **LAST**.
- `:460` **bypasses Cloudflare** (direct origin) but the domain is **CF-fronted**, so certbot HTTP-01 (port 80) validates against Cloudflare, not the origin. Use **DNS-01** (or a Cloudflare **Origin CA** cert) — see [[infra_tls_cloudflare]].
- The **connectors** (`wa`, `notifier`) call `http://127.0.0.1:60` on loopback. A blanket `:60→:460` 301 would redirect those to the self-signed `:460` and break them. The redirect must **except loopback**, or point the connectors at `:460`/keep an internal HTTP path.

## Ordered steps

### 0. Pre-flight
- Confirm DNS/Cloudflare access (needed for DNS-01 or Origin CA).
- `sudo cp -a /etc/apache2/sites-available/bukutamu-60.conf{,.pre-tls-bak}`
- `sudo cp -a /etc/apache2/sites-available/bukutamu-ssl.conf{,.pre-tls-bak}`
- `sudo cp -a backend/application/modules/api/controllers/Auth.php{,.pre-tls-bak}`

### 1. Trusted cert on :460
Option A (Let's Encrypt DNS-01):
```bash
sudo certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /root/.secrets/cloudflare.ini \
  -d bukutamu.bpsmalut.com
# → /etc/letsencrypt/live/bukutamu.bpsmalut.com/{fullchain,privkey}.pem
```
Option B (Cloudflare Origin CA cert): generate in CF dashboard → save to `/etc/ssl/certs/bukutamu-origin.crt` + key. (Valid only behind CF; fine since `:460` origin is only reached via the CF-fronted name.)

### 2. Point :460 at the trusted cert + add HSTS
In `bukutamu-ssl.conf` (currently lines 8–9, self-signed):
```apache
    SSLCertificateFile    /etc/letsencrypt/live/bukutamu.bpsmalut.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/bukutamu.bpsmalut.com/privkey.pem
    # HSTS — only AFTER you're confident HTTPS is stable (hard to walk back)
    Header always set Strict-Transport-Security "max-age=15552000"
```
`sudo apache2ctl configtest && sudo apachectl -k graceful`
Verify: `curl -sSI https://bukutamu.bpsmalut.com:460/api/auth/check` → 401 with a **trusted** cert (no `-k`).

### 3. 301 redirect on :60 — EXCEPT loopback/internal
In `bukutamu-60.conf`, redirect external clients but leave loopback working:
```apache
    # Keep internal/loopback API on HTTP (connectors use 127.0.0.1:60).
    # Redirect only real external hostnames to the secure port.
    RewriteEngine On
    RewriteCond %{REMOTE_ADDR} !^127\.0\.0\.1$
    RewriteCond %{HTTP_HOST}    !^(127\.0\.0\.1|localhost)$
    RewriteRule ^/(.*)$ https://bukutamu.bpsmalut.com:460/$1 [R=301,L]
```
`configtest && apachectl -k graceful`. Verify: external `curl -I http://…:60/api/auth/check` → 301 to `:460`; loopback `curl -I http://127.0.0.1:60/api/auth/check` → still 401 (no redirect); connectors (`pm2 logs bukutamu-wa`) still heartbeating.

### 4. LAST — Secure cookie (Auth.php, live-on-save)
Only after steps 1–3 verify green. Both `setcookie('jwt_token', …)` sites (login ~line 125, logout ~line 168):
```php
'secure'   => true,   // #2 — HTTPS enforced by the :60->:460 301 + trusted cert
```
This is live within 2s of save. Verify immediately: log in via `https://…:460`, confirm the `jwt_token` cookie has the `Secure` flag (browser devtools / `curl -i`), and that an authed page works.

## Rollback
- Cookie: restore `Auth.php.pre-tls-bak` (live in 2s).
- Redirect/cert: restore the `*.pre-tls-bak` vhosts + `apachectl -k graceful`; the self-signed cert path still works as before.
- HSTS caveat: once sent, browsers pin HTTPS for `max-age`. Keep `max-age` short (e.g. 300) during testing; raise to 15552000 only when confident.

## Verify checklist
- [ ] `curl -sSI https://…:460/api/auth/check` → 401, trusted cert, no `-k`
- [ ] external `http://…:60/...` → 301 → `:460`
- [ ] `http://127.0.0.1:60/...` → NOT redirected (connectors intact)
- [ ] login sets `Secure; HttpOnly; SameSite=Strict` cookie
- [ ] `pm2 logs bukutamu-wa` / `bukutamu-notifier` still healthy after the vhost reload
