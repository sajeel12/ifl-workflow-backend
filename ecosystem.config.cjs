module.exports = {
  apps: [{
    name: 'workflow_app',
    script: 'server.js',
    instances: 1,
    watch: false,
    max_restarts: 5,
    min_uptime: '10s',
    max_memory_restart: '500M',

    // Wait for process.send('ready') before marking the app online.
    // Prevents PM2 from routing traffic before DB is up.
    wait_ready: true,
    listen_timeout: 30000,   // ms to wait for ready signal before giving up
    kill_timeout: 5000,      // ms to wait for SIGTERM graceful shutdown before SIGKILL

    env: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }]
};
