# deploy-config — environments, env vars, rollback

## Environments

| Name | Host | Domain | DB | Notes |
| --- | --- | --- | --- | --- |
| **Production** | this server | `bukutamu.bpsmalut.com` (:60/:460) | `db_tamdes` | Only real environment. |
| **Frozen archive** | this server | `old-bukutamu.bpsmalut.com` | separate DB | Read-only legacy; do NOT deploy here. |
| **Kiosk PCs** | per kiosk | `localhost:5300` | n/a | Each runs its own `print/`. |

There is **no staging**. Plan deploys for low-traffic windows.

## Service ports (must not collide)

| Port | Owner | Notes |
| --- | --- | --- |
| `:60`  | Apache HTTP — bukutamu backend | public |
| `:460` | Apache HTTPS — bukutamu backend | public |
| `:3060` | PM2 `bukutamu-frontend` (serves `dist/`) | localhost |
| `:5001` | dashboard-pst | localhost |
| `:5173` | Vite dev (frontend `npm run dev`) | localhost, dev-only |
| `:5300` | print server | runs on kiosk PCs, not this server |
| `:5000` | **DO NOT USE** — owned by `pds-backend` | |

## Required environment / config

### Backend (CodeIgniter)
- `backend/application/config/database.php` — DB creds. **Never** commit
  real creds; `DB_DATABASE` env var can override the literal default.
- `backend/application/config/config.php` — `encryption_key`, base URL.
- HMAC token secret lives in the same config — rotation invalidates all
  active kiosk continuation tokens (acceptable).

### Frontend
- No `.env` is checked in. Vite reads `import.meta.env.VITE_*` from
  `frontend/.env.*` (git-ignored). At minimum:
  - `VITE_API_URL` — points at `https://bukutamu.bpsmalut.com:460`
    in prod.

### MySQL
- `/root/.my.cnf` holds root creds for shell access. Rotation history
  tracked in `docs/REMAINING_PHASE_B.md` and recent commits.

## Rollback

### Backend
Apache serves files straight from the working tree, so rolling back =
checking out the previous SHA + graceful reload:

```bash
cd /var/www/html/bukutamu
git log --oneline -5                  # find the last good SHA
git checkout <SHA> -- backend/        # restore JUST the backend tree
sudo apachectl -k graceful
```

If the issue is in a single file, restore from the on-disk `.backup`
the global edit rule produced:

```bash
cp backend/application/.../Foo.php.backup backend/application/.../Foo.php
sudo apachectl -k graceful
```

### Frontend
PM2 serves `dist/`, so the new bundle is in `dist/` already. To roll back:

```bash
cd /var/www/html/bukutamu
git checkout <previous-SHA> -- frontend/
cd frontend && npm install && npm run build
pm2 restart bukutamu-frontend
```

There is no separate "release" artifact — `dist/` is regenerated each
deploy. If you need a fast rollback, keep a copy of `dist/` BEFORE the
deploy:

```bash
cp -a frontend/dist frontend/dist.prev   # before deploy
# … if something breaks …
rm -rf frontend/dist && mv frontend/dist.prev frontend/dist
pm2 restart bukutamu-frontend
```

### Print
Per-kiosk: `git checkout <SHA> -- print/ && npm install && pm2 restart
bukutamu-print` on the kiosk PC.

## What to communicate after rollback

- Tell the user immediately: "Rolled back to SHA `abc1234`. Re-run the
  6-step kiosk smoke test."
- Open an issue / note in `docs/` describing what went wrong and what
  needs to change before the next deploy attempt.
