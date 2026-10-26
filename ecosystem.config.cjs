// ═══════════════════════════════════════════════════════════
// ecosystem.config.cjs  (updated)
// ═══════════════════════════════════════════════════════════
module.exports = {
  apps: [
    {
      name:   'brat-generator',
      script: 'src/server.js',

      // PM2 handle paralelisme antar CPU.
      // Worker threads di dalam server.js handle isolasi CPU-bound per process.
      // instances: -1  →  pakai semua core, sisakan 1 untuk OS + Redis + cloudflared
      instances:  -1,
      exec_mode: 'cluster',

      autorestart: true,
      exp_backoff_restart_delay: 100,
      watch: false,

      max_memory_restart: '8G',

      // kill_timeout harus > server.requestTimeout (12000) + sedikit buffer
      kill_timeout:    15000,
      listen_timeout:  10000,

      env: {
        NODE_ENV: 'production',
        PORT:     3010,
        HOST:     '127.0.0.1',

        // ── Tuning Worker Thread Pool ──────────────────────────────────────
        // WORKERS_PER_PROCESS: Worker threads per PM2 instance.
        // Rumus aman: 2 (default). Jangan samakan dengan os.cpus().length
        // karena PM2 sudah spawn N instances = N CPU cores dipakai.
        //
        // Total threads aktif = instances × WORKERS_PER_PROCESS
        // Contoh 8-core: 7 instances × 2 workers = 14 threads (OK)
        // Jangan: 7 instances × 7 workers = 49 threads (OOM)
        WORKERS_PER_PROCESS: 2,

        // ── Tuning Concurrency Limiter ─────────────────────────────────────
        // MAX_CONCURRENT: Request generate aktif per PM2 instance.
        // Total global = instances × MAX_CONCURRENT
        // Contoh: 4 × 7 instances = 28 concurrent generate global
        MAX_CONCURRENT: 4,

        // ── Tuning Queue ───────────────────────────────────────────────────
        // MAX_QUEUE_DEPTH: Antrian worker per process sebelum reject 503.
        // Kecil karena PM2 sudah distribute — tidak perlu queue panjang.
        MAX_QUEUE_DEPTH: 20,

        // ── Tuning LRU Cache ───────────────────────────────────────────────
        // MEM_CACHE_MB per instance.
        // Total RAM untuk cache = instances × MEM_CACHE_MB
        // Contoh: 30MB × 7 = 210MB — masih aman
        MEM_CACHE_MB: 30,
      },

      env_development: {
        NODE_ENV:            'development',
        PORT:                3010,
        HOST:                '127.0.0.1',
        WORKERS_PER_PROCESS: 2,
        MAX_CONCURRENT:      4,
        MAX_QUEUE_DEPTH:     10,
        MEM_CACHE_MB:        20,
      },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      'logs/error.log',
      out_file:        'logs/out.log',
      merge_logs:      true,
    },
  ],
};
