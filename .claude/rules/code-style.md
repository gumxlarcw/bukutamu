# Code Style — bukutamu

## Frontend (TypeScript + React 19)

### Formatting
- Lint: `npm run lint` (ESLint flat config: js recommended + `typescript-eslint`
  recommended + `react-hooks` + `react-refresh`).
- No Prettier on the frontend — match the surrounding file's quote/indent style
  by reading it first.
- ESLint ignores `dist/` and `public/**` (the `public/` dir holds `.ts` HLS
  segments, not TypeScript).

### Imports
- Use the `@/*` alias for anything under `src/` (configured in `tsconfig.json`
  and `vite.config.ts`). Don't use long `../../../` chains.
- Order: external → `@/` aliased → relative — one blank line between groups.

### Naming
- React components: `PascalCase.tsx`, export name matching the filename. Match
  the directory you're in (#47 — this is the de-facto convention, verified):
  - **Pages** (`src/pages/`) use a **default** export
    (e.g. `VisitLogPage.tsx` → `export default function VisitLogPage`).
  - **Components** (`src/components/`) use a **named** export
    (e.g. `ConsultationDataForm.tsx` → `export function ConsultationDataForm`).
  - `src/components/ui/` follows shadcn's **kebab-case** filenames
    (e.g. `dropdown-menu.tsx`).
- Hooks: `useFoo` in `src/hooks/`.
- API wrappers: lowerCamelCase file in `src/api/` (one file per backend
  resource, e.g. `evaluations.ts`).
- Types: `src/types/<domain>.ts`, named exports, prefer `interface` for object
  shapes that may extend, `type` for unions / mapped types.

### React patterns
- Data fetching: `@tanstack/react-query` (`useQuery` / `useMutation`). Don't
  raw-axios in components — go through `src/api/*.ts`.
- Form state: local `useState` or controlled inputs; this project does not use
  react-hook-form.
- Toasts: `sonner`. Never `alert()`.
- Class names: `clsx(...)` + `twMerge(...)` (often via a shared `cn` helper) —
  follow whatever the file does.
- Don't introduce new state managers (Redux/Zustand/Jotai). react-query +
  context is the established pattern.

### TypeScript
- `strict` mode is on. Don't add `// @ts-ignore` — fix the type or use a
  narrowly scoped `as` cast with a comment explaining why.
- Avoid `any`. Prefer `unknown` + narrowing at the boundary.

## Backend (CodeIgniter 3 PHP, HMVC)

### Formatting
- `cd backend && npx prettier --write <file>` uses `@prettier/plugin-php`.
- Run on changed files only — wholesale formatting creates noisy diffs.
- 4-space indent (CI3 convention); opening brace on same line for control
  structures, new line for class/method definitions.

### Conventions
- Controllers live in `backend/application/modules/api/controllers/`. One file
  per resource (e.g. `Visits.php`), `class Visits extends Api_base`.
- `Api_base.php` handles auth, JSON output, CORS — extend it, don't reimplement.
- Models in `backend/application/modules/api/models/`.
- Routes registered in `backend/application/config/routes.php`. The web
  modules (legacy CI3 HMVC) were deleted on 2026-05-17 — this is an API-only
  backend now.

### Naming
- Controller methods that handle a single resource by id take `$id` as the
  first param: `function detail($id)`, `function status($id)`.
- Routes always nested: `api/visits/(:num)/status` → `visits/status/$1`.

### SQL
- Use CI3 Query Builder where possible (`$this->db->where(...)->get(...)`).
- Raw `$this->db->query("...", [$bind])` is fine for complex joins — always
  use bound params, never string-concat user input.
- Database name is `db_tamdes`. Do not rename it.

## Print server (Node)

- Single `server.js`. Keep it minimal — escpos-usb is the only domain logic.
- Payload must accept both `no` and `nomor_antrian` (alias for backwards
  compat with older callers).
