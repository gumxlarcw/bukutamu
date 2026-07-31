import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // `public/` berisi file .ts berupa MPEG-TS segment HLS (bukan TypeScript) — exclude
  // supaya ESLint tidak mencoba parse-nya. `dist/` adalah hasil build.
  // `dist-staging/` juga hasil build — dipakai deploy atomik (build ke staging,
  // lalu salin aditif ke dist/) supaya dist/ yang sedang dilayani PM2 tidak pernah
  // dikosongkan. Tanpa dikecualikan, ESLint melaporkan ratusan error dari bundel.
  globalIgnores(['dist', 'dist-staging', 'public/**']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
])
