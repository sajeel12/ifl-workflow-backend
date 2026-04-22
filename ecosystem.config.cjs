module.exports = {
  apps: [{
    name: 'workflow_app',
    script: 'server.js',
    watch: false,               // Disable watch to prevent restart loops
    max_restarts: 5,            // Limit restarts to avoid infinite loops
    min_uptime: '10s',          // Consider app crashed if it exits within 10s
    max_memory_restart: '500M', // Restart if memory exceeds 500MB
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }]
};
