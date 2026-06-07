module.exports = {
  apps: [
    {
      name: 'bukutamu-frontend',
      script: 'npx',
      args: 'serve dist -p 3060 --no-clipboard -c ../public/serve.json',
      cwd: '/var/www/html/bukutamu/frontend',
      interpreter: 'none',
    },
    {
      // Web Push sender for admin desktop notifications (Tier-2). Reads the
      // git-ignored notifier/config.json (VAPID + internal secret). Polls
      // /api/notifications/dispatch and pushes new notifications per role.
      name: 'bukutamu-notifier',
      script: 'server.js',
      cwd: '/var/www/html/bukutamu/notifier',
      autorestart: true,
      max_restarts: 20,
    },
    {
      // WhatsApp online data-request connector (whatsapp-web.js). Reads the
      // git-ignored wa/config.json (internalSecret = push_internal_secret).
      // ToS-risky surface, isolated here; if the number is jailed, bukutamu core is untouched.
      name: 'bukutamu-wa',
      script: 'server.js',
      cwd: '/var/www/html/bukutamu/wa',
      autorestart: true,
      max_restarts: 20,
      // Semua jalur pemulihan baru (init gagal, watchdog, unhandledRejection, auth_failure,
      // disconnect) bertumpu pada PM2 me-restart. Backoff eksponensial mencegah spin-loop +
      // launch Chromium beruntun (risiko ban) saat jaringan mati lama; reset otomatis setelah
      // 30s uptime stabil. min_uptime menandai restart <30s sebagai tak stabil. max_memory_restart
      // mereap kebocoran headless-Chromium (~186MB RSS). kill_timeout > default 1600ms agar
      // wwebjs/Chromium tutup bersih.
      exp_backoff_restart_delay: 200,
      min_uptime: '30s',
      kill_timeout: 5000,
      max_memory_restart: '350M',
    },
  ],
}
