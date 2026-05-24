/* PM2 ecosystem — Robotrend IA (raiz do projeto = parent desta pasta) */
const path = require('path');
const root = path.join(__dirname, '..');

module.exports = {
  apps: [{
    name: 'robotrend-ia',
    script: 'backend/server.js',
    cwd: root,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '350M',
    env: {
      NODE_ENV: 'production',
      PORT: 3010,
    },
    out_file: path.join(root, 'logs', 'out.log'),
    error_file: path.join(root, 'logs', 'err.log'),
    merge_logs: true,
    time: true,
  }],
};
