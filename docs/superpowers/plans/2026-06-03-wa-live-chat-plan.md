# WA Live Chat — Implementation Plan

> Executes `docs/superpowers/specs/2026-06-03-wa-live-chat-design.md`. No automated tests in
> this repo → verification is `php -l` / `npx tsc -b` / `npm run lint` / `npm run build` +
> manual curl + a live "halo" walk. Backup-before-edit + diff per repo rule. No
> `Co-Authored-By`. Adversarial review workflow before deploy.

**Build order:** DB+infra → backend → connector → frontend → verify → review → deploy.

---

### Task 1 — DB + storage + infra
- Create `docs/migrations/2026-06-03-wa-messages.sql` (table per spec). Apply via
  `mysql db_tamdes < file`.
- Create `backend/assets/wa_media/` (owner www-data, 0775); add `.gitkeep`; ignore contents
  in `.gitignore` (`backend/assets/wa_media/*` keep `.gitkeep`).
- PHP limits: add `backend/.user.ini` (or vhost) `upload_max_filesize=30M`,
  `post_max_size=31M`, `memory_limit=256M`. Apache `LimitRequestBody 33554432` on the
  bukutamu vhost. Verify which mechanism the vhost honors before editing live config.
- Verify: `SHOW COLUMNS FROM wa_messages`; `ls -ld backend/assets/wa_media`.

### Task 2 — Backend `chat-ingest` (inbound)
- `Wa.php::chat_ingest()` (internal-secret). Input `{phone, wa_chat_id, wa_msg_id, type,
  body?, media_b64?, media_mime?, media_name?}`. Normalize phone. Active-session guard
  (reuse the same query as ingest: awaiting_form<48h OR submitted+visit≠selesai). Dedup:
  `SELECT id FROM wa_messages WHERE wa_msg_id=?` → 200 idempotent. If media: validate mime
  whitelist + size (decoded ≤25 MB), save `wa_media/<uuid>.<ext>`. Insert `in/received`.
- Route `api/wa/chat-ingest`. Verify with a crafted curl (internal-secret).

### Task 3 — Backend thread + send-text
- `Wa.php::messages()` GET (auth + PST role whitelist, same as inbox). Params `phone`,
  `after` (int). Return rows id>after asc; map media rows to `media_url=/api/wa/media/{id}`,
  strip raw path. POST branch `{phone, wa_chat_id, body}`: rate-limit `wa/chat:<admin id>`,
  validate body 1..4096, insert `out/text/pending`.
- Routes `api/wa/messages` (GET+POST). Verify shapes vs `frontend/src/api/wa.ts`.

### Task 4 — Backend upload + media serve
- `Wa.php::messages_upload()` POST multipart (auth+role, rate-limit). `$_FILES['file']`:
  size ≤25 MB, ext+mime whitelist, magic-byte sniff (`finfo`), uuid name → wa_media. Insert
  `out/image|document/pending` with caption. Return the created row.
- `Wa.php::media($id)` GET (auth+role): look up row, `readfile` with `Content-Type` +
  `Content-Disposition` (inline for image, attachment for document). 404 if missing.
- Routes `api/wa/messages/upload`, `api/wa/media/(:num)`.

### Task 5 — Backend poll/ack extend (outbound chat)
- `poll()`: after building `wa_outbox` items, also fetch `wa_messages` where
  `direction='out' AND status='pending'`; append as `{id, kind:'chat', wa_chat_id, body,
  media_path, media_mime}`. Tag outbox items `kind:'outbox'`. Keep legacy fields so an old
  connector still works.
- `ack()`: accept `{ids?}` (legacy → outbox) and/or `{chat_ids?}` → mark
  `wa_messages.status='sent'`. Add a `fail()` path or let connector mark failed via a small
  `POST /api/wa/messages/fail {ids}` (internal-secret) → `status='failed'`.
- Verify both ack branches.

### Task 6 — Connector `wa/server.js`
- `on('message')`: keep ingest. Add: `const wid = msg.id?._serialized`; if `msg.hasMedia`
  → `const m = await msg.downloadMedia()` (`m.data` base64, `m.mimetype`, `m.filename`);
  POST `/api/wa/chat-ingest` with `{phone, wa_chat_id, wa_msg_id:wid, type, body, media_b64,
  media_mime, media_name}`. Wrap in try/catch; never block session logic.
- `tick()`: items carry `kind`. `kind==='chat'` + `media_path` → `MessageMedia.fromFilePath(
  path.join(ASSETS, media_path))` (+ caption); else `sendMessage(text)`. Pacing `await
  sleep(~1200ms)` between sends. Ack by kind (`chat_ids` vs `ids`). On final failure call
  `/api/wa/messages/fail`.
- `node --check`; restart `bukutamu-wa`.

### Task 7 — Frontend types + api
- `types/wa.ts`: `WaMessage {id, direction, msg_type, body, media_url?, media_name?,
  media_mime?, status, created_at}`.
- `api/wa.ts`: `getMessages(phone, after)`, `sendText({phone,wa_chat_id,body})`,
  `uploadFile(FormData)`, `mediaUrl(id)`.

### Task 8 — Frontend ChatPopup
- `components/wa/ChatPopup.tsx`: floating draggable/minimizable; bubble list (in/out,
  image thumb, doc chip, status tick); composer (textarea + 📎 + send). Poll `getMessages`
  every 4 s (after=lastId), append. Client guards (≤25 MB, whitelist, ≤4096, non-empty).
  Optimistic out bubble with pending state.
- `LayananOnlineInboxPage.tsx`: row "Chat" button → open ChatPopup(phone, wa_chat_id,
  nama, id_kunjungan). Manage open popups in a small state array (stack/dedupe by phone).
- Bump `public/sw.js` cache (v19).

### Task 9 — Verify, review, deploy
- `php -l` changed PHP; `npx tsc -b` + `npm run lint`.
- Adversarial review **workflow** (dimensions: FE↔BE/connector contract parity; security —
  upload path traversal / mime spoof / auth+role / internal-secret / SSRF; anti-flood &
  ban-safety; regression on wa_outbox/sessions/poll/ack; popup state). Verify each finding.
- Fix confirmed. `npm run build`; reload Apache; restart `bukutamu-wa` + `bukutamu-frontend`.
  Smoke (loopback 401, FE HTML, SW v19). Live "halo" → chat round-trip + image + doc.
