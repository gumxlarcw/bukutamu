# WA Live Chat (Layanan Online) — Design Spec

**Date:** 2026-06-03
**Status:** Approved (brainstorming complete)

## Goal

Embed a WhatsApp-style **live two-way chat** in the admin "Layanan Online" page so
petugas PST can converse with an online requester **without opening WhatsApp**, including
**image + document** attachments. Must be **additive** (no regression to the existing
WA intake / templated / session-detection flows) and **flood-safe** (protect both UX and
the linked WhatsApp number from a ban).

## Decisions (locked)

| Topic | Decision |
| --- | --- |
| UI | **Floating popup** (draggable, minimizable), opened from an inbox row |
| Media | Two-way **text + image + document**; max **25 MB**; whitelist mime + magic-byte |
| Transport | **Polling** via react-query (~4 s while popup open); no WebSocket |
| Binding | Conversation is **per-phone** (`phone_norm`), like WhatsApp; `id_kunjungan` is context only |
| Large file | All files ≤25 MB sent **inline as WA media** (no link-fallback in v1) |

## Architecture

Bridge: **web (petugas) ↔ WhatsApp (requester)** through the existing `bukutamu-wa`
connector. New layer is purely additive:

- New table `wa_messages` = single source of truth for the conversation (in + out).
- `wa_outbox` stays ONLY for templated system messages (intake link / confirmation /
  eval) — untouched.
- Connector `on('message')` keeps its existing session-detection ingest unchanged, then
  *additionally* stores the chat message (and downloads media) — guarded so it only stores
  for a contact with an active session, and dedups by WhatsApp message id.
- Connector `tick()` polls templated (`wa_outbox`) **and** chat (`wa_messages` out-pending),
  sending text or `MessageMedia.fromFilePath()` with pacing between sends.

## Data model — `wa_messages`

```sql
CREATE TABLE wa_messages (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  phone_norm  VARCHAR(32)  NOT NULL,
  wa_chat_id  VARCHAR(64)  NOT NULL,            -- exact @c.us/@lid reply target
  id_kunjungan INT NULL,                        -- context if the session became a visit
  direction   ENUM('in','out') NOT NULL,
  msg_type    ENUM('text','image','document') NOT NULL DEFAULT 'text',
  body        TEXT NULL,                        -- text or media caption
  media_path  VARCHAR(255) NULL,                -- relative to backend/assets/wa_media/
  media_mime  VARCHAR(100) NULL,
  media_name  VARCHAR(200) NULL,
  wa_msg_id   VARCHAR(80)  NULL,                -- WhatsApp message id (inbound dedup)
  status      ENUM('pending','sent','failed','received') NOT NULL DEFAULT 'pending',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_phone_created (phone_norm, id),
  UNIQUE KEY uniq_wa_msg (wa_msg_id)            -- NULL allowed/duplicable in MySQL → inbound dedup
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

## API contract (`Wa.php`, all additive)

Response envelope as always: `{success, data, message}`.

- `GET  /api/wa/messages?phone=<norm>&after=<id>` — auth + PST role. Returns
  `data: WaMessage[]` (id asc, > after). Media rows include `media_url`
  (`/api/wa/media/{id}`), never the raw path.
- `POST /api/wa/messages` `{phone, body}` — auth + PST role, rate-limited. The reply target
  `wa_chat_id` is resolved SERVER-SIDE from the contact's latest `wa_session` (FE never sends
  it — prevents a petugas forging the reply address). Inserts `direction='out',
  msg_type='text', status='pending'`. 422 if body empty/too long (>4096).
- `POST /api/wa/messages/upload` (multipart: `phone, file, caption?`) — auth + PST role,
  rate-limited; `wa_chat_id` resolved server-side as above. Validate ≤25 MB + whitelist
  mime/ext + magic-byte (finfo, fail-closed); save to `backend/assets/wa_media/<uuid>.<ext>`;
  insert `out, image|document, pending`.
- `GET  /api/wa/media/{id}` — auth + PST role; streams the file with correct mime.
- `POST /api/wa/chat-ingest` `{phone, wa_chat_id, wa_msg_id, type, body?, media_path?,
  media_mime?, media_name?}` — internal-secret (connector). The connector writes the
  downloaded media to `wa_media/<uuid>.<ext>` on the shared disk and sends only the
  **basename** (no base64 over HTTP → no `post_max_size` pressure). Backend validates the
  basename pattern (`^[a-z0-9-]+\.[a-z0-9]+$`, resolved realpath inside wa_media), size,
  and magic-byte; dedups on `wa_msg_id`; inserts `direction='in', status='received'`. Only
  stores if an active session exists for the phone.
- `poll()` — extended: in addition to `wa_outbox` pending, also returns `chat` out-pending
  from `wa_messages` as items `{id, kind:'chat', wa_chat_id, body, media_path, media_mime}`.
  Existing `wa_outbox` items returned as `{..., kind:'outbox'}` (shape stays backward
  compatible; `kind` defaults to outbox for old connector tolerance).
- `ack()` — extended: accepts `{outbox_ids?, chat_ids?}` (or the unified `[{id,kind}]`),
  marks the right table. Old `{ids}` still acks outbox.

Rate-limit key: `wa/chat:<id_admin>` ~15/min (reuse `require_rate_limit`).

## Connector (`wa/server.js`, additive)

- `on('message')`: **unchanged** ingest call first. Then, best-effort: derive
  `wa_msg_id = msg.id?._serialized`; if `msg.hasMedia` → `msg.downloadMedia()` → write the
  decoded buffer to `wa_media/<uuid>.<ext>` (shared disk); POST `/api/wa/chat-ingest` with
  the basename + mime + filename (no base64 over HTTP). Failures logged, never block.
- `tick()`: poll items now carry `kind`. For `kind==='chat'` with `media_path`, send
  `MessageMedia.fromFilePath(<assetsAbsPath>/<media_path>)` (+ caption=body); else text.
  Insert a small delay (~1–1.5 s) between sends. Ack groups by kind. Reuse `failCount` cap.

## Frontend

- `types/wa.ts`: `WaMessage` interface.
- `api/wa.ts`: `getMessages(phone, after)`, `sendText(...)`, `uploadFile(...)` (FormData),
  `mediaUrl(id)`.
- `components/wa/ChatPopup.tsx`: floating, draggable, minimizable panel. Header (nama/nomor +
  minimize/close), scrollable bubble list (in left / out right; image thumbnail opens full,
  document chip downloads; per-out-message status tick pending→sent→failed), composer
  (textarea + 📎 file picker + send). Polls `getMessages` every 4 s while open; appends after
  the last id. Disable send while pending; client guards (size/type/empty/length).
- `LayananOnlineInboxPage.tsx`: each row gets a "Chat" affordance → opens `ChatPopup` for that
  phone (+ id_kunjungan context). Multiple popups allowed (stack).
- Bump `public/sw.js` cache.

## Anti-flooding

- Petugas: ~15 msgs/min/admin (server rate-limit) + FE debounce; text ≤4096 chars.
- Upload: ≤25 MB; mime/ext whitelist (jpg/jpeg/png/webp/gif, pdf, doc/docx, xls/xlsx) +
  magic-byte sniff; uuid filename (no user-controlled path).
- Connector: sequential send + ~1–1.5 s pacing; max 3 attempts (existing `failCount`); on
  exhaustion mark `wa_messages.status='failed'`.
- Inbound: dedup by `wa_msg_id`; store only for active-session contacts.

## No-regression guarantees

- `wa_outbox` + all templated flows untouched.
- Connector session-detection ingest path unchanged; chat storage is a separate, guarded,
  best-effort addition.
- Only new tables/endpoints; `poll/ack` changed additively (old shape still works).
- Offline kiosk / queue / status gates untouched.

## Infra

- PHP: `upload_max_filesize=30M`, `post_max_size=31M`, adequate `memory_limit`,
  `max_execution_time` for the upload endpoint (php.ini or per-dir).
- Apache: `LimitRequestBody` ≥ ~32 MB on the API vhost.
- `backend/assets/wa_media/` dir, writable by `www-data` (backend writes inbound + serves;
  connector reads outbound files from the same disk).

## Out of scope / risks

- Not a full WA client: no voice notes, reactions, reply-quoting, read receipts.
- DM only (groups stay ignored).
- wwebjs may intermittently fail near 25 MB → surfaced as `failed`; link-fallback deferred.
- WhatsApp ban risk reduced (pacing/limits) but not eliminated.
