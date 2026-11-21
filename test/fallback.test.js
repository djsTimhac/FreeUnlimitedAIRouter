import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { Router } from '../src/router.js';

/**
 * Start a throwaway upstream on a random port. `close` also drops keep-alive
 * sockets, otherwise the process lingers after the tests finish.
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} handler
 */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`,
        close: () => {
          server.closeAllConnections();
          server.close();
        }
      });
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => resolve(raw));
  });
}

/** @param {{id:string, url:string, model:string}[]} entries */
function buildRouter(entries) {
  return new Router(
    {
      maxAttempts: 4,
      defaultAlias: 'free',
      connectTimeoutMs: 3000,
      requestTimeoutMs: 3000,
      cooldowns: { rateLimit: 30_000, auth: 30_000, server: 1000, network: 1000, payment: 60_000 },
      aliases: { free: entries.map((e) => `${e.id}/${e.model}`) },
      providers: entries.map((entry) => ({
        id: entry.id,
        label: `Fake ${entry.id}`,
        style: 'openai',
        baseUrl: entry.url,
        headers: {},
        keys: ['test-key'],
        free: true,
        enabled: true,
        configured: true,
        requiresKey: true,
        models: [{ id: entry.model, tags: ['free'] }]
      }))
    },
    /** @type {any} */ ({ record() {} })
  );
}

function completion(content) {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 }
  });
}

test('falls back to the next provider after a 429 and parks the key', async (t) => {
  let rateLimitedHits = 0;

  const limited = await startServer((req, res) => {
    rateLimitedHits++;
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '20' });
    res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }));
  });
  t.after(limited.close);

  const healthy = await startServer(async (req, res) => {
    JSON.parse(await readBody(req));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(completion('served by the healthy provider'));
  });
  t.after(healthy.close);

  const router = buildRouter([
    { id: 'pa', url: limited.url, model: 'limited-model' },
    { id: 'pb', url: healthy.url, model: 'healthy-model' }
  ]);

  const result = await router.chat(
    { model: 'free', messages: [{ role: 'user', content: 'hello' }] },
    { candidates: router.candidatesFor('free'), stream: false }
  );

  assert.equal(result.ok, true);
  assert.equal(result.kind, 'json');
  assert.equal(result.provider.id, 'pb', 'the healthy provider answers');
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].provider, 'pa');
  assert.equal(result.attempts[0].status, 429);
  assert.equal(result.attempts[0].cooldownMs, 30_000, 'honours Retry-After: 20s, escalated once');

  const parked = router.providers.get('pa').pool.snapshot();
  assert.equal(parked.keys[0].cooling, true);

  // A second request must skip the cooling provider without calling it again.
  const second = await router.chat(
    { model: 'free', messages: [{ role: 'user', content: 'again' }] },
    { candidates: router.candidatesFor('free'), stream: false }
  );
  assert.equal(second.ok, true);
  assert.equal(second.provider.id, 'pb');
  assert.equal(rateLimitedHits, 1, 'cooling key must not be retried');
  assert.equal(second.attempts.length, 1);
  assert.equal(second.attempts[0].skipped, true, 'the cooling provider is recorded as skipped');
  assert.equal(second.attempts[0].provider, 'pa');
});

test('treats a 200 response with an error envelope as a failure', async (t) => {
  const broken = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'no credits left' } }));
  });
  t.after(broken.close);

  const healthy = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(completion('ok'));
  });
  t.after(healthy.close);

  const router = buildRouter([
    { id: 'pa', url: broken.url, model: 'broken-model' },
    { id: 'pb', url: healthy.url, model: 'healthy-model' }
  ]);

  const result = await router.chat(
    { messages: [{ role: 'user', content: 'hi' }] },
    { candidates: router.candidatesFor('free'), stream: false }
  );

  assert.equal(result.ok, true);
  assert.equal(result.provider.id, 'pb');
  assert.equal(result.attempts.at(-1).error, 'no credits left');
});

test('streams the winning provider body through untouched', async (t) => {
  const streamer = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}\n\n');
    res.write('data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n');
    res.end('data: [DONE]\n\n');
  });
  t.after(streamer.close);

  const router = buildRouter([{ id: 'pa', url: streamer.url, model: 'stream-model' }]);

  const result = await router.chat(
    { model: 'free', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    { candidates: router.candidatesFor('free'), stream: true }
  );

  assert.equal(result.ok, true);
  assert.equal(result.kind, 'stream');
  const text = await new Response(result.upstream.body).text();
  assert.match(text, /"Hel"/);
  assert.match(text, /data: \[DONE\]/);
});

test('returns a structured failure when every provider is unreachable', async () => {
  const router = buildRouter([{ id: 'pz', url: 'http://127.0.0.1:65535', model: 'dead-model' }]);
  const result = await router.chat(
    { messages: [{ role: 'user', content: 'hi' }] },
    { candidates: router.candidatesFor('free'), stream: false }
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].type, 'network');
});
