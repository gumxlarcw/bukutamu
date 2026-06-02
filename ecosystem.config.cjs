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
    },
  ],
}
