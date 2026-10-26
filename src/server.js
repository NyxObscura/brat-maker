// src/server.js

import express from 'express';
import { createClient } from 'redis';
import { createHash } from 'crypto';
import { Worker } from 'worker_threads';
import { LRUCache } from 'lru-cache';
import os from 'os';
import pino from 'pino';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Logger ────────────────────────────────────────────────────────────────────
const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(process.env.NODE_ENV === 'development' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

// ── Redis ─────────────────────────────────────────────────────────────────────
const redis = createClient({
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
    reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
  },
  ...(process.env.REDIS_PASSWORD && process.env.REDIS_PASSWORD !== 'null'
    ? { password: process.env.REDIS_PASSWORD }
    : {}),
});

redis.on('error',        (err) => log.error({ err }, '[redis] connection error'));
redis.on('connect',      ()    => log.info('[redis] connected'));
redis.on('reconnecting', ()    => log.warn('[redis] reconnecting...'));

await redis.connect();

// ── App Configuration ─────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

app.disable('x-powered-by');
// JANGAN trust proxy — kita handle IP sendiri via CF-Connecting-IP
app.set('trust proxy', false);

app.use(express.static(new URL('../public', import.meta.url).pathname));
app.use(express.json({ limit: '10kb' }));

// ── Helper: Real IP ───────────────────────────────────────────────────────────
// Hanya percaya CF-Connecting-IP (diset oleh Cloudflare, tidak bisa di-spoof).
// X-Forwarded-For DIABAIKAN karena bisa diisi bebas oleh attacker.
function getRealIP(req) {
  return req.headers['cf-connecting-ip']   // Cloudflare tunnel ✅
    || req.headers['x-real-ip']            // Nginx reverse proxy
    || req.socket.remoteAddress            // Direct connection fallback
    || 'unknown';
}

// ── Worker Thread Pool ────────────────────────────────────────────────────────
//
// PENTING — Kenapa WORKERS_PER_PROCESS kecil (default 2)?
//
// PM2 Cluster Mode sudah handle paralelisme antar CPU:
//   instances: -1  →  misal 7 process di 8-core CPU
//
// Kalau WORKERS_PER_PROCESS = os.cpus().length (7):
//   7 PM2 process × 7 workers = 49 threads total → OOM / thrashing
//
// Dengan WORKERS_PER_PROCESS = 2:
//   7 PM2 process × 2 workers = 14 threads → seimbang, aman
//
// Fungsi worker thread di sini: ISOLASI CPU-bound canvas dari event loop,
// bukan horizontal scaling (itu tugas PM2).
//
const WORKERS_PER_PROCESS = parseInt(process.env.WORKERS_PER_PROCESS) || 2;
const WORKER_PATH = join(__dirname, 'imageWorker.js');

log.info(`[worker] PID ${process.pid} spawning ${WORKERS_PER_PROCESS} worker threads`);

class WorkerPool {
  constructor(size, workerPath) {
    this.workerPath = workerPath;
    this.queue      = [];
    this.workers    = [];
    this.free       = [];
    this.activeJobs = new Map();

    for (let i = 0; i < size; i++) {
      this._spawnWorker(i);
    }
  }

  _spawnWorker(idx) {
    const w = new Worker(this.workerPath);

    if (idx >= this.workers.length) {
      this.workers.push(w);
    } else {
      this.workers[idx] = w;
    }

    this.free.push(idx);
    w.on('message', (msg) => this._handleMessage(idx, msg));
    w.on('error',   (err) => this._handleCrash(idx, err));
  }

  _handleCrash(idx, err) {
    log.error({ err, pid: process.pid }, `[worker:${idx}] crashed, respawning in 500ms`);

    const job = this.activeJobs.get(idx);
    if (job) {
      this.activeJobs.delete(idx);
      job.reject(new Error('Worker crashed'));
    }

    setTimeout(() => {
      this._spawnWorker(idx);
      this._drain();
    }, 500);
  }

  _handleMessage(idx, msg) {
    const job = this.activeJobs.get(idx);
    if (!job) return;

    this.activeJobs.delete(idx);
    this.free.push(idx);

    if (msg.ok) {
      job.resolve(Buffer.from(msg.buffer));
    } else {
      job.reject(new Error(msg.error));
    }

    this._drain();
  }

  _drain() {
    while (this.free.length > 0 && this.queue.length > 0) {
      const job = this.queue.shift();
      if (job.timedOut) continue; // Skip job yang sudah timeout di queue

      const idx = this.free.shift();
      this.activeJobs.set(idx, job);
      this.workers[idx].postMessage(job.params);
    }
  }

  run(params) {
    return new Promise((resolve, reject) => {
      // Queue depth per-process kecil karena PM2 sudah distribute load
      const MAX_QUEUE_DEPTH = parseInt(process.env.MAX_QUEUE_DEPTH) || 20;
      if (this.queue.length >= MAX_QUEUE_DEPTH) {
        return reject(new Error('QUEUE_FULL'));
      }

      let timedOut = false;

      const wrappedResolve = (val) => { clearTimeout(timer); resolve(val); };
      const wrappedReject  = (err) => { clearTimeout(timer); reject(err);  };

      const timer = setTimeout(() => {
        timedOut = true;
        wrappedReject(new Error('QUEUE_TIMEOUT'));
      }, 8000);

      this.queue.push({
        params,
        resolve: wrappedResolve,
        reject:  wrappedReject,
        get timedOut() { return timedOut; },
      });

      this._drain();
    });
  }

  get queueDepth()  { return this.queue.length; }
  get activeCount() { return this.activeJobs.size; }
}

const workerPool = new WorkerPool(WORKERS_PER_PROCESS, WORKER_PATH);

// ── L1 Cache: In-Memory LRU ───────────────────────────────────────────────────
// Setiap PM2 instance punya LRU sendiri — ini normal dan diinginkan.
// Hot images ter-cache di semua instance setelah beberapa hit pertama.
// MEM_CACHE_MB kecil per-instance supaya total RAM masuk akal:
//   30MB × 7 instances = 210MB untuk cache gambar
const MEM_CACHE_MB = parseInt(process.env.MEM_CACHE_MB) || 30;
const memCache = new LRUCache({
  max:             500,
  maxSize:         MEM_CACHE_MB * 1024 * 1024,
  sizeCalculation: (buf) => buf.length,
  ttl:             1000 * 60 * 60, // 1 jam
});

// ── Pertahanan 1: Security Headers ───────────────────────────────────────────
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options':    'nosniff',
    'X-Frame-Options':           'DENY',
    'X-XSS-Protection':          '1; mode=block',
    'Referrer-Policy':           'no-referrer',
    'Permissions-Policy':        'interest-cohort=()',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  });
  next();
});

// ── Pertahanan 2: Request Logger ─────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    log.info({
      method: req.method,
      url:    req.url,
      status: res.statusCode,
      ms:     Date.now() - start,
      ip:     getRealIP(req),
      pid:    process.pid,
    });
  });
  next();
});

// ── Pertahanan 3: Rate Limiter (Token Bucket via Redis Lua, Fail-Closed) ──────
//
// FIX UTAMA: key Redis pakai getRealIP() → hanya CF-Connecting-IP.
// DoS script yang inject X-Forwarded-For random tidak bisa bypass ini
// karena kita tidak pernah membaca header tersebut.
//
// Shared via Redis → rate limit berlaku GLOBAL across semua PM2 instances.
// Artinya 30 token = 30 req/menit per IP, bukan 30 × 7 instances.
//
const RATE = {
  MAX_TOKENS:  30,
  REFILL_RATE: 10,
  WINDOW_TTL:  60,
};

const RL_SCRIPT = `
  local key     = KEYS[1]
  local now     = tonumber(ARGV[1])
  local max     = tonumber(ARGV[2])
  local rate    = tonumber(ARGV[3])
  local ttl     = tonumber(ARGV[4])

  local data    = redis.call('HMGET', key, 'tokens', 'ts')
  local tokens  = tonumber(data[1]) or max
  local ts      = tonumber(data[2]) or now

  local elapsed = math.max(0, (now - ts) / 1000)
  tokens        = math.min(max, tokens + elapsed * rate)

  if tokens < 1 then
    local wait = math.ceil((1 - tokens) / rate * 1000)
    return { 0, tostring(tokens), wait }
  end

  tokens = tokens - 1
  redis.call('HMSET', key, 'tokens', tostring(tokens), 'ts', tostring(now))
  redis.call('EXPIRE', key, ttl)
  return { 1, tostring(tokens), 0 }
`;

async function rateLimiter(req, res, next) {
  const ip  = getRealIP(req); // ← Hanya CF-Connecting-IP, bukan X-Forwarded-For
  const key = `rl:brat:${ip}`;
  const now = Date.now();

  try {
    const result = await redis.eval(RL_SCRIPT, {
      keys:      [key],
      arguments: [
        String(now),
        String(RATE.MAX_TOKENS),
        String(RATE.REFILL_RATE),
        String(RATE.WINDOW_TTL),
      ],
    });

    const allowed   = result[0] === 1;
    const remaining = Math.floor(parseFloat(result[1]));
    const retryMs   = Number(result[2]);

    res.set('X-RateLimit-Limit',     String(RATE.MAX_TOKENS));
    res.set('X-RateLimit-Remaining', String(Math.max(0, remaining)));

    if (!allowed) {
      res.set('Retry-After', String(Math.ceil(retryMs / 1000)));
      return res.status(429).json({
        error:   'Too Many Requests',
        message: `Rate limit tercapai. Coba lagi dalam ${Math.ceil(retryMs / 1000)} detik.`,
      });
    }

    next();
  } catch (err) {
    log.error({ err, ip }, '[ratelimit] redis error, blocking request (fail-closed)');
    return res.status(500).json({
      error:   'Internal Server Error',
      message: 'Layanan sedang tidak stabil.',
    });
  }
}

// ── Pertahanan 4: Concurrency Limiter ────────────────────────────────────────
//
// FIX: Diturunkan dari 1000 ke nilai kecil yang masuk akal per-process.
// Total concurrency actual = MAX_CONCURRENT × jumlah PM2 instances.
// Contoh: 4 × 7 instances = 28 concurrent generate secara global.
//
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT) || 4;
let activeGenerations = 0;

function concurrencyLimiter(req, res, next) {
  if (activeGenerations >= MAX_CONCURRENT) {
    log.warn({
      ip:     getRealIP(req),
      active: activeGenerations,
      pid:    process.pid,
    }, '[concurrency] overloaded, rejecting');
    return res.status(503).json({
      error:   'Service Unavailable',
      message: 'Server sedang sibuk memproses gambar. Silakan coba beberapa saat lagi.',
    });
  }

  activeGenerations++;
  let released = false;
  const release = () => { if (!released) { activeGenerations--; released = true; } };

  res.on('finish', release);
  res.on('close',  release);
  next();
}

// ── Cache Helpers ─────────────────────────────────────────────────────────────
const CACHE_TTL = 3600;

function cacheKey(text, bg, color) {
  return 'img:brat:' + createHash('sha1')
    .update(`${text}|${bg || ''}|${color || ''}`)
    .digest('hex');
}

async function getCachedRedis(key) {
  try { return (await redis.getBuffer(key)) || null; }
  catch { return null; }
}

function setCacheRedis(key, buffer) {
  redis.set(key, buffer, { EX: CACHE_TTL })
    .catch(err => log.warn({ err }, '[cache] redis write failed'));
}

// ── Route: GET /generate ──────────────────────────────────────────────────────
app.get('/generate', rateLimiter, concurrencyLimiter, async (req, res) => {
  const { text, bg, color } = req.query;

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'Bad Request', message: 'Parameter "text" wajib diisi.' });
  }
  if (text.trim().length > 200) {
    return res.status(400).json({ error: 'Bad Request', message: '"text" maksimal 200 karakter.' });
  }

  const safeText  = text.trim();
  const safeBg    = bg    && /^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(bg)    ? bg    : undefined;
  const safeColor = color && /^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(color) ? color : undefined;

  const key = cacheKey(safeText, safeBg, safeColor);

  // L1: Memory LRU (< 1ms, zero network round trip)
  const memHit = memCache.get(key);
  if (memHit) {
    res.set({
      'Content-Type':   'image/png',
      'Content-Length': memHit.length,
      'Cache-Control':  'public, max-age=86400, s-maxage=604800, stale-while-revalidate=3600',
      'X-Cache':        'MEM-HIT',
    });
    return res.status(200).end(memHit);
  }

  // L2: Redis (~ 1-3ms)
  const redisHit = await getCachedRedis(key);
  if (redisHit) {
    memCache.set(key, redisHit); // Warm up L1 untuk request berikutnya
    res.set({
      'Content-Type':   'image/png',
      'Content-Length': redisHit.length,
      'Cache-Control':  'public, max-age=86400, s-maxage=604800, stale-while-revalidate=3600',
      'X-Cache':        'REDIS-HIT',
    });
    return res.status(200).end(redisHit);
  }

  // L3: Generate via worker thread (CPU-bound, event loop tetap bebas)
  try {
    const imageBuffer = await workerPool.run({ text: safeText, bg: safeBg, color: safeColor });

    memCache.set(key, imageBuffer);
    setCacheRedis(key, imageBuffer);

    res.set({
      'Content-Type':   'image/png',
      'Content-Length': imageBuffer.length,
      'Cache-Control':  'public, max-age=86400, s-maxage=604800, stale-while-revalidate=3600',
      'X-Cache':        'MISS',
    });
    return res.status(200).end(imageBuffer);

  } catch (err) {
    if (err.message === 'QUEUE_FULL' || err.message === 'QUEUE_TIMEOUT') {
      log.warn({ ip: getRealIP(req), reason: err.message }, '[/generate] queue rejected');
      return res.status(503).json({
        error:   'Service Unavailable',
        message: 'Server terlalu sibuk. Coba lagi sebentar.',
      });
    }
    if (err.message?.length < 300) {
      return res.status(400).json({ error: 'Bad Request', message: err.message });
    }
    log.error({ err }, '[/generate] unexpected error');
    return res.status(500).json({ error: 'Internal Server Error', message: 'Gagal generate gambar.' });
  }
});

// ── Route: GET /health ────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const redisOk = redis.isReady;
  res.status(redisOk ? 200 : 503).json({
    status:         redisOk ? 'ok' : 'degraded',
    redis:          redisOk ? 'connected' : 'disconnected',
    pid:            process.pid,
    activeGen:      activeGenerations,
    maxConcurrent:  MAX_CONCURRENT,
    workersPerProc: WORKERS_PER_PROCESS,
    queueDepth:     workerPool.queueDepth,
    workerActive:   workerPool.activeCount,
    memCacheSize:   memCache.size,
    memCacheMB:     MEM_CACHE_MB,
    ts:             Date.now(),
  });
});

// ── 404 & Error Handlers ──────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not Found', message: 'Endpoint tersedia: GET /generate, GET /health' });
});

app.use((err, _req, res, _next) => {
  log.error({ err }, '[unhandled]');
  res.status(500).json({ error: 'Internal Server Error', message: 'Terjadi kesalahan.' });
});

// ── Start Server ──────────────────────────────────────────────────────────────
const server = app.listen(PORT, HOST, () => {
  log.info(`[PID ${process.pid}] Brat Generator running on http://${HOST}:${PORT}`);
  log.info(`Workers/proc: ${WORKERS_PER_PROCESS} | MaxConcurrent/proc: ${MAX_CONCURRENT} | LRU: ${MEM_CACHE_MB}MB`);
});

server.setTimeout(15000);
server.headersTimeout = 10000; // Cegah slowloris / header injection
server.requestTimeout = 12000;

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
// PM2 kirim SIGINT saat reload/stop.
// kill_timeout = 12000ms di ecosystem.config → beri waktu drain request aktif.
const shutdown = async (signal) => {
  log.info(`[PID ${process.pid}] [${signal}] Graceful shutdown initiated...`);

  server.close(async () => {
    log.info(`[PID ${process.pid}] HTTP server closed.`);
    await redis.quit();
    log.info(`[PID ${process.pid}] Redis closed.`);
    process.exit(0);
  });

  setTimeout(() => {
    log.error(`[PID ${process.pid}] Forced shutdown after timeout.`);
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

export default app;
