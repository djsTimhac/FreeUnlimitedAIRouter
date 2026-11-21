import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAliases, buildProvider, parseKeyList } from '../src/config.js';
import { KeyPool, parseRetryAfter } from '../src/keys.js';
import { parseModelSpec } from '../src/model.js';
import { Router, classifyStatus, extractProviderError } from '../src/router.js';

const PROVIDERS = new Set(['groq', 'openrouter', 'openai', 'github']);

test('parseKeyList splits and de-duplicates', () => {
  assert.deepEqual(parseKeyList('a,b , a\nc;d'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(parseKeyList(undefined, ''), []);
  assert.deepEqual(parseKeyList(['x', 'y,x']), ['x', 'y']);
});

test('parseModelSpec recognises provider prefixes only', () => {
  assert.deepEqual(parseModelSpec('groq/llama-3.3-70b-versatile', PROVIDERS), {
    provider: 'groq',
    model: 'llama-3.3-70b-versatile'
  });
  // OpenRouter ids contain both "/" and ":" — they must not be mistaken for a prefix.
  assert.deepEqual(parseModelSpec('meta-llama/llama-3.3-70b-instruct:free', PROVIDERS), {
    provider: null,
    model: 'meta-llama/llama-3.3-70b-instruct:free'
  });
  assert.deepEqual(parseModelSpec('openrouter:deepseek/deepseek-r1:free', PROVIDERS), {
    provider: 'openrouter',
    model: 'deepseek/deepseek-r1:free'
  });
  assert.deepEqual(parseModelSpec('github/openai/gpt-4o-mini', PROVIDERS), {
    provider: 'github',
    model: 'openai/gpt-4o-mini'
  });
  assert.deepEqual(parseModelSpec('unknown-model', PROVIDERS), { provider: null, model: 'unknown-model' });
});

test('buildProvider reads keys, base URL and models from the environment', () => {
  const provider = buildProvider(
    {
      id: 'groq',
      label: 'Groq',
      style: 'openai',
      baseUrl: 'https://api.groq.com/openai/v1',
      env: ['GROQ_API_KEYS', 'GROQ_API_KEY'],
      free: true,
      models: [{ id: 'llama-3.1-8b-instant', tags: ['fast'] }]
    },
    {},
    { GROQ_API_KEYS: 'k1, k2' }
  );
  assert.deepEqual(provider.keys, ['k1', 'k2']);
  assert.equal(provider.configured, true);
  assert.equal(provider.baseUrl, 'https://api.groq.com/openai/v1');

  const missing = buildProvider(
    { id: 'openai', label: 'OpenAI', style: 'openai', baseUrl: 'https://api.openai.com/v1', env: ['OPENAI_API_KEY'], free: false, models: [] },
    {},
    {}
  );
  assert.equal(missing.configured, false);
});

test('local providers need no key and use the env base URL', () => {
  const provider = buildProvider(
    {
      id: 'ollama',
      label: 'Ollama',
      style: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      baseUrlEnv: 'OLLAMA_BASE_URL',
      modelsEnv: 'OLLAMA_MODELS',
      env: [],
      free: true,
      requiresKey: false,
      models: []
    },
    {},
    { OLLAMA_BASE_URL: 'http://127.0.0.1:9999/v1/', OLLAMA_MODELS: 'qwen2.5:7b, llama3.2' }
  );
  assert.equal(provider.baseUrl, 'http://127.0.0.1:9999/v1');
  assert.deepEqual(provider.keys, ['']);
  assert.deepEqual(provider.models.map((m) => m.id), ['qwen2.5:7b', 'llama3.2']);
  assert.equal(provider.configured, true);
});

test('buildAliases derives free/all and honours overrides', () => {
  const aliases = buildAliases(
    [
      { id: 'groq', free: true, models: [{ id: 'free-model', tags: ['free'] }, { id: 'paid-model', tags: [] }] },
      { id: 'openai', free: false, models: [{ id: 'gpt-4o', tags: ['smart'] }] }
    ],
    { fast: ['groq/free-model'] }
  );
  assert.deepEqual(aliases.free, ['groq/free-model']);
  assert.deepEqual(aliases.all, ['groq/free-model', 'groq/paid-model', 'openai/gpt-4o']);
  assert.deepEqual(aliases.fast, ['groq/free-model']);
  assert.ok(aliases.smart.includes('openai/gpt-4o'));
});

test('KeyPool rotates and parks rate-limited keys', () => {
  const pool = new KeyPool('test', ['a', 'b']);
  const first = pool.pick();
  const second = pool.pick();
  assert.equal(first?.key, 'a', 'least recently used first');
  assert.equal(second?.key, 'b');

  pool.markFailure(first, { cooldownMs: 60_000, status: 429 });
  assert.equal(pool.usable().length, 1);

  const retry = pool.pick();
  assert.equal(retry?.key, 'b', 'the healthy key is reused');
  pool.markFailure(retry, { cooldownMs: 60_000, status: 429 });

  assert.equal(pool.pick(), null, 'every key is cooling down');
  assert.ok(pool.waitMs() > 0);
  assert.equal(pool.snapshot().usable, 0);

  pool.reset();
  assert.equal(pool.usable().length, 2);
});

test('KeyPool does not penalise request-level failures', () => {
  const pool = new KeyPool('test', ['a']);
  const entry = pool.pick();
  pool.markFailure(entry, { cooldownMs: 0, status: 400, penalize: false });
  assert.equal(pool.usable().length, 1);
  assert.equal(entry.failures, 1);
  assert.equal(pool.snapshot().keys[0].lastStatus, 400);
});

test('parseRetryAfter understands seconds, dates and groq-style resets', () => {
  assert.equal(parseRetryAfter(new Headers({ 'retry-after': '30' })), 30_000);
  assert.equal(parseRetryAfter(new Headers({ 'x-ratelimit-reset-requests': '1m30s' })), 90_000);
  assert.equal(parseRetryAfter(new Headers({ 'x-ratelimit-reset-tokens': '250ms' })), 250);
  assert.equal(parseRetryAfter(new Headers({})), null);
});

test('classifyStatus maps upstream failures to cool-downs', () => {
  const cooldowns = { rateLimit: 1000, auth: 2000, server: 3000, network: 4000, payment: 5000 };
  assert.equal(classifyStatus(429, cooldowns).cooldownMs, 1000);
  assert.equal(classifyStatus(401, cooldowns).cooldownMs, 2000);
  assert.equal(classifyStatus(503, cooldowns).cooldownMs, 3000);
  assert.equal(classifyStatus(400, cooldowns).penalize, false);
});

test('extractProviderError reads the common envelope shapes', () => {
  assert.equal(extractProviderError('{"error":{"message":"rate limited"}}'), 'rate limited');
  assert.equal(extractProviderError('{"error":"nope"}'), 'nope');
  assert.equal(extractProviderError('plain text'), 'plain text');
  assert.equal(extractProviderError(''), '');
});

function makeRouter() {
  const config = {
    maxAttempts: 3,
    defaultAlias: 'free',
    cooldowns: { rateLimit: 1000, auth: 1000, server: 1000, network: 1000, payment: 1000 },
    connectTimeoutMs: 2000,
    requestTimeoutMs: 2000,
    aliases: {
      free: ['groq/llama-3.1-8b-instant', 'openrouter/meta-llama/llama-3.3-70b-instruct:free'],
      all: []
    },
    providers: [
      {
        id: 'groq',
        label: 'Groq',
        style: 'openai',
        baseUrl: 'http://127.0.0.1:65535/v1',
        headers: {},
        keys: ['k1'],
        free: true,
        enabled: true,
        configured: true,
        requiresKey: true,
        models: [{ id: 'llama-3.1-8b-instant', tags: ['free'] }]
      },
      {
        id: 'openrouter',
        label: 'OpenRouter',
        style: 'openai',
        baseUrl: 'http://127.0.0.1:65535/v1',
        headers: {},
        keys: [],
        free: true,
        enabled: true,
        configured: false,
        requiresKey: true,
        models: [{ id: 'meta-llama/llama-3.3-70b-instruct:free', tags: ['free'] }]
      }
    ]
  };
  return new Router(config, /** @type {any} */ ({ record() {} }));
}

test('Router resolves aliases and provider prefixes, skipping unconfigured providers', () => {
  const router = makeRouter();
  const free = router.candidatesFor('free');
  assert.deepEqual(free.map((c) => `${c.provider}/${c.model}`), ['groq/llama-3.1-8b-instant']);

  const direct = router.candidatesFor('groq/llama-3.1-8b-instant');
  assert.equal(direct.length, 1);
  assert.equal(direct[0].provider, 'groq');

  // openrouter has no keys → nothing to try
  assert.deepEqual(router.candidatesFor('openrouter/meta-llama/llama-3.3-70b-instruct:free'), []);
  assert.deepEqual(router.candidatesFor('does-not-exist'), []);
  // empty model falls back to the default alias
  assert.deepEqual(router.candidatesFor('').map((c) => c.provider), ['groq']);
});

test('Router reports every candidate failure and returns a useful error', async () => {
  const router = makeRouter();
  const result = await router.chat(
    { model: 'free', messages: [{ role: 'user', content: 'hi' }] },
    { candidates: router.candidatesFor('free'), stream: false }
  );

  assert.equal(result.ok, false);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].provider, 'groq');
  assert.equal(result.attempts[0].type, 'network');
  assert.match(result.error, /ECONNREFUSED|fetch failed|connect|bad port/i);
});
