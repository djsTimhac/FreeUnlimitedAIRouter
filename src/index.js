#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { loadDotEnv } from './env.js';
import { pipeStream, readJsonBody, safeEqual, sendError, sendJson } from './http.js';
import { log, setLogLevel } from './logger.js';
import { Router } from './router.js';
import { SseParser, parseSseBlock } from './sse.js';
import { Stats } from './stats.js';

const VERSION = '1.0.0';
const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, '..');
const PUBLIC_DIR = join(PROJECT_ROOT, 'public');

const HELP = `
FreeUnlimitedAIRouter ${VERSION}
One OpenAI-compatible endpoint in front of many AI providers.

Usage:
  free-ai-router [options]

Options:
  --port <n>        Port to listen on           (env PORT, default 8787)
  --host <addr>     Address to bind             (env HOST, default 0.0.0.0)
  --config <path>   router.config.json location (env CONFIG_PATH)
  --no-dotenv       Do not read .env
  --help            Show this help
  --version         Print the version

Endpoints:
  POST /v1/chat/completions   OpenAI-compatible chat (streaming supported)
  GET  /v1/models             Aliases and concrete provider models
  GET  /health                Liveness probe
  GET  /api/status            Providers, keys, aliases and counters (JSON)
  GET  /                      Dashboard

Configuration: see .env.example and router.config.example.json.
`;

function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--version' || arg === '-v') args.version = true;
    else if (arg === '--no-dotenv') args.noDotenv = true;
    else if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[name] = next;
        i++;
      } else {
        args[name] = true;
      }
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (args.version) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

if (!args.noDotenv) {
  const loaded = loadDotEnv(join(PROJECT_ROOT, '.env'));
  if (loaded) log.info(`Loaded ${loaded} variable(s) from .env`);
}

if (typeof args.port === 'string') process.env.PORT = args.port;
if (typeof args.host === 'string') process.env.HOST = args.host;
if (typeof args.config === 'string') process.env.CONFIG_PATH = args.config;

let config;
try {
  config = loadConfig({ cwd: PROJECT_ROOT });
} catch (error) {
  process.stderr.write(`Configuration error: ${/** @type {Error} */ (error).message}\n`);
  process.exit(1);
}
setLogLevel(config.logLevel);

const stats = new Stats();
const router = new Router(config, stats);
const startedAt = Date.now();

/* ── helpers ─────────────────────────────────────────────────────────────── */

/** @param {import('node:http').ServerResponse} res */
function applyCors(res) {
  res.setHeader('access-control-allow-origin', config.corsOrigin);
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key, openai-organization, openai-project');
  res.setHeader('access-control-expose-headers', 'x-router-provider, x-router-model, x-router-attempts');
  res.setHeader('access-control-max-age', '86400');
  if (config.corsOrigin !== '*') res.setHeader('vary', 'origin');
}

/** @param {import('node:http').IncomingMessage} req */
function isAuthorized(req) {
  if (!config.apiKey) return true;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const alt = req.headers['x-api-key'];
  return safeEqual(bearer, config.apiKey) || safeEqual(typeof alt === 'string' ? alt : '', config.apiKey);
}

/** @param {import('node:http').ServerResponse} res */
function unauthorized(res) {
  sendError(res, 401, 'Missing or invalid API key. Send "Authorization: Bearer <ROUTER_API_KEY>".', {
    type: 'authentication_error',
    code: 'invalid_api_key'
  });
}

/** @param {any[]} attempts */
function attemptHint(attempts) {
  if (!Array.isArray(attempts) || !attempts.length) return undefined;
  const parts = attempts.slice(-6).map((attempt) => {
    const detail = attempt.skipped ? attempt.error : `${attempt.status ?? 'network'} ${attempt.error || ''}`.trim();
    return `${attempt.provider}/${attempt.model}: ${detail}`;
  });
  return `Tried ${attempts.length} candidate(s) — ${parts.join(' | ')}`.slice(0, 900);
}

/** @param {any} payload */
function estimateTokens(payload) {
  try {
    return Math.ceil(JSON.stringify(payload.messages ?? '').length / 4);
  } catch {
    return 0;
  }
}

const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/dashboard', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/favicon.svg', { file: 'favicon.svg', type: 'image/svg+xml' }],
  ['/favicon.ico', { file: 'favicon.svg', type: 'image/svg+xml' }]
]);

/** @param {import('node:http').ServerResponse} res @param {string} path */
async function serveStatic(res, path) {
  const entry = STATIC_FILES.get(path);
  if (!entry) return false;
  try {
    const body = await readFile(join(PUBLIC_DIR, entry.file));
    res.writeHead(200, {
      'content-type': entry.type,
      'content-length': body.length,
      'cache-control': 'no-cache'
    });
    res.end(body);
  } catch (error) {
    log.error(`Cannot serve ${entry.file}`, error);
    sendError(res, 500, 'Dashboard assets are missing from the installation.');
  }
  return true;
}

/* ── chat ────────────────────────────────────────────────────────────────── */

/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
async function handleChat(req, res) {
  const started = Date.now();

  /** @type {any} */
  let payload;
  try {
    payload = await readJsonBody(req, config.maxBodyBytes);
  } catch (error) {
    return sendError(res, /** @type {any} */ (error).status || 400, /** @type {Error} */ (error).message);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return sendError(res, 400, 'Request body must be a JSON object.');
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return sendError(res, 400, '"messages" must be a non-empty array of chat messages.');
  }

  const requested =
    typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : config.defaultAlias;
  const candidates = router.candidatesFor(requested);

  if (!candidates.length) {
    const ready = router.readyProviders();
    return sendError(res, 404, `No provider is available for model "${requested}".`, {
      type: 'model_not_found',
      code: 'model_not_found',
      hint: ready.length
        ? `Ready providers: ${ready.map((p) => p.id).join(', ')}. GET /v1/models lists every alias and model.`
        : 'No provider is configured yet. Add at least one API key to .env or router.config.json (see README).'
    });
  }

  const stream = payload.stream === true;
  const aborter = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) aborter.abort();
  };
  res.on('close', onClose);

  let result;
  try {
    result = await router.chat(payload, { candidates, stream, signal: aborter.signal });
  } catch (error) {
    res.off('close', onClose);
    log.error('Routing crashed', error);
    return sendError(res, 500, 'Internal routing error.');
  }

  if (!result.ok) {
    res.off('close', onClose);
    if (result.aborted) {
      res.destroy();
      return;
    }
    stats.record({
      provider: 'router',
      model: requested,
      requested,
      ok: false,
      status: result.status,
      ms: Date.now() - started,
      attempts: result.attempts?.length || 0,
      error: result.error
    });
    return sendError(res, result.status || 502, result.error || 'Every provider failed.', {
      type: 'upstream_error',
      code: 'all_providers_failed',
      hint: attemptHint(result.attempts || [])
    });
  }

  const meta = {
    provider: result.provider.id,
    model: result.model,
    attempts: result.attempts.length + 1,
    latency_ms: Date.now() - started
  };
  const headers = {
    'x-router-provider': meta.provider,
    'x-router-model': meta.model,
    'x-router-attempts': String(meta.attempts),
    'x-router-latency-ms': String(meta.latency_ms)
  };

  if (stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...headers
    });

    const parser = new SseParser();
    let contentChars = 0;
    /** @type {any} */
    let usage = null;

    const onChunk = (chunk) => {
      const text = Buffer.from(chunk).toString('utf8');
      for (const block of parser.push(text)) {
        const parsed = parseSseBlock(block);
        if (!parsed || parsed.raw === '[DONE]') continue;
        const data = parsed.data;
        if (!data || typeof data !== 'object') continue;
        if (data.usage) usage = data.usage;
        const delta = data.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') contentChars += delta.length;
      }
    };

    try {
      await pipeStream(res, result.upstream.body, onChunk);
    } catch (error) {
      log.warn('Stream interrupted', error);
    } finally {
      res.off('close', onClose);
      stats.record({
        provider: meta.provider,
        model: meta.model,
        requested,
        ok: true,
        status: 200,
        ms: Date.now() - started,
        attempts: meta.attempts,
        stream: true,
        promptTokens: Number(usage?.prompt_tokens ?? estimateTokens(payload)),
        completionTokens: Number(usage?.completion_tokens ?? Math.ceil(contentChars / 4))
      });
      log.info(`[${meta.provider}] ${meta.model} → 200 stream ${Date.now() - started}ms (${meta.attempts} attempt(s))`);
    }
    return;
  }

  const body = {
    ...result.json,
    router: {
      ...meta,
      requested,
      fallbacks: meta.attempts - 1
    }
  };
  const text = JSON.stringify(body);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers
  });
  res.end(text);
  res.off('close', onClose);

  stats.record({
    provider: meta.provider,
    model: meta.model,
    requested,
    ok: true,
    status: 200,
    ms: meta.latency_ms,
    attempts: meta.attempts,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens
  });
  log.info(`[${meta.provider}] ${meta.model} → 200 ${meta.latency_ms}ms (${meta.attempts} attempt(s))`);
}

/* ── router ──────────────────────────────────────────────────────────────── */

const server = createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];
  applyCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (path === '/health' && req.method === 'GET') {
      const ready = router.readyProviders();
      return sendJson(res, 200, {
        status: ready.length ? 'ok' : 'degraded',
        version: VERSION,
        uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
        providers_ready: ready.length,
        providers_total: router.providers.size
      });
    }

    const isApi = path.startsWith('/v1/') || path.startsWith('/api/');
    if (isApi && !isAuthorized(req)) return unauthorized(res);

    if (path === '/v1/models' && req.method === 'GET') {
      return sendJson(res, 200, router.modelsPayload());
    }

    if (path === '/v1/chat/completions' && req.method === 'POST') {
      return handleChat(req, res);
    }

    if (path === '/api/status' && req.method === 'GET') {
      return sendJson(res, 200, {
        version: VERSION,
        uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
        auth_required: Boolean(config.apiKey),
        default_alias: config.defaultAlias,
        max_attempts: config.maxAttempts,
        providers: router.status(),
        aliases: Object.fromEntries(
          Object.entries(config.aliases).map(([name, refs]) => [
            name,
            { candidates: refs, available: router.candidatesFor(name).length }
          ])
        ),
        stats: stats.snapshot()
      });
    }

    if (path === '/api/stats' && req.method === 'GET') {
      return sendJson(res, 200, stats.snapshot());
    }

    if (path === '/api/reset' && req.method === 'POST') {
      router.resetCooldowns();
      stats.reset();
      log.info('State reset from the dashboard');
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && (await serveStatic(res, path))) return;

    sendError(res, 404, `No route for ${req.method} ${path}.`, {
      type: 'not_found',
      hint: 'Try POST /v1/chat/completions, GET /v1/models, GET /health or GET /.'
    });
  } catch (error) {
    log.error(`Unhandled error on ${req.method} ${path}`, error);
    if (!res.headersSent) sendError(res, 500, 'Internal server error.');
    else if (!res.writableEnded) res.end();
  }
});

server.headersTimeout = 65_000;
server.requestTimeout = 0; // long generations are legitimate
server.keepAliveTimeout = 65_000;

server.listen(config.port, config.host, () => {
  const ready = router.readyProviders();
  const free = ready.filter((p) => p.free).length;
  const candidates = config.aliases[config.defaultAlias]?.length ?? 0;

  process.stdout.write(
    [
      '',
      `  FreeUnlimitedAIRouter v${VERSION}`,
      `  listening on   http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`,
      `  dashboard      http://localhost:${config.port}/`,
      `  providers      ${ready.length} ready / ${router.providers.size} known (${free} free tier)`,
      `  default alias  ${config.defaultAlias} (${candidates} candidate(s))`,
      `  auth           ${config.apiKey ? 'ROUTER_API_KEY enabled' : 'open — no ROUTER_API_KEY set'}`,
      config.configPath ? `  config         ${config.configPath}` : '  config         (using defaults)',
      '',
      ready.length
        ? ''
        : '  ⚠  No provider is configured yet. Add an API key to .env and restart.\n',
      ''
    ]
      .filter((line) => line !== '')
      .join('\n') + (ready.length ? '\n' : '\n')
  );

  if (ready.length) {
    log.info(`Ready: ${ready.map((p) => `${p.id}(${p.keys.length} key${p.keys.length === 1 ? '' : 's'})`).join(', ')}`);
  } else {
    log.warn('Running without providers — requests will return 404 until a key is configured.');
  }
});

server.on('error', (error) => {
  const err = /** @type {any} */ (error);
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(`Port ${config.port} is already in use. Set PORT=<n> and try again.\n`);
  } else {
    process.stderr.write(`Server error: ${err.message}\n`);
  }
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log.info('Shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
