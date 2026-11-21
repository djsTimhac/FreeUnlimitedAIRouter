import { combineSignals } from './http.js';
import { KeyPool, parseRetryAfter } from './keys.js';
import { log } from './logger.js';
import { formatDuration, parseModelSpec } from './model.js';
import { callProvider } from './providers/index.js';

/**
 * @typedef {Object} Candidate
 * @property {string} provider
 * @property {string} model
 * @property {string} [alias]
 */

/**
 * Turn an HTTP status from an upstream provider into a cool-down decision.
 * @param {number} status
 * @param {any} cooldowns
 */
export function classifyStatus(status, cooldowns) {
  if (status === 429) return { cooldownMs: cooldowns.rateLimit, retryable: true, penalize: true, type: 'rate_limit' };
  if (status === 401 || status === 403) return { cooldownMs: cooldowns.auth, retryable: true, penalize: true, type: 'auth' };
  if (status === 402) return { cooldownMs: cooldowns.payment, retryable: true, penalize: true, type: 'payment' };
  if (status === 408 || status === 425) return { cooldownMs: cooldowns.network, retryable: true, penalize: true, type: 'network' };
  if (status >= 500) return { cooldownMs: cooldowns.server, retryable: true, penalize: true, type: 'server' };
  // 400/404/413/422 are usually about this specific request or model, not the
  // key: move on to the next provider without burning the key's health.
  return { cooldownMs: 0, retryable: true, penalize: false, type: 'request' };
}

/**
 * @param {unknown} input
 * @returns {string}
 */
export function extractProviderError(input) {
  if (input === null || input === undefined || input === '') return '';
  if (typeof input === 'object') {
    const anyInput = /** @type {any} */ (input);
    if (anyInput.error !== undefined) {
      const nested = anyInput.error;
      if (typeof nested === 'string') return nested;
      if (nested && typeof nested === 'object') return nested.message ? String(nested.message) : JSON.stringify(nested).slice(0, 400);
    }
    if (typeof anyInput.message === 'string') return anyInput.message;
    if (typeof anyInput.detail === 'string') return anyInput.detail;
    if (anyInput.detail) return JSON.stringify(anyInput.detail).slice(0, 400);
    return JSON.stringify(anyInput).slice(0, 400);
  }

  const text = String(input);
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return JSON.stringify(parsed).slice(0, 400);
    return extractProviderError(parsed) || text.slice(0, 400);
  } catch {
    return text.slice(0, 400);
  }
}

export class Router {
  /**
   * @param {any} config
   * @param {import('./stats.js').Stats} stats
   */
  constructor(config, stats) {
    this.config = config;
    this.stats = stats;
    /** @type {Map<string, any>} */
    this.providers = new Map();

    for (const provider of config.providers) {
      this.providers.set(provider.id, {
        ...provider,
        pool: new KeyPool(provider.id, provider.keys)
      });
    }
  }

  get providerIds() {
    return new Set(this.providers.keys());
  }

  /** Providers that have a base URL, keys and models: the ones we can call. */
  readyProviders() {
    return [...this.providers.values()].filter((p) => p.configured);
  }

  /**
   * Ordered list of provider/model pairs to try for a requested model.
   * @param {string} requested
   * @returns {Candidate[]}
   */
  candidatesFor(requested) {
    const raw = typeof requested === 'string' ? requested.trim() : '';
    const spec = parseModelSpec(raw, this.providerIds);

    /** @type {Candidate[]} */
    let refs = [];

    if (spec.provider) {
      refs = [{ provider: spec.provider, model: spec.model }];
    } else if (raw && Object.prototype.hasOwnProperty.call(this.config.aliases, raw)) {
      refs = this.config.aliases[raw].map((ref) => {
        const parsed = parseModelSpec(ref, this.providerIds);
        return { provider: parsed.provider ?? '', model: parsed.model, alias: raw };
      });
    } else if (!raw || raw === 'auto' || raw === 'default') {
      const fallback = this.config.aliases[this.config.defaultAlias] || [];
      refs = fallback.map((ref) => {
        const parsed = parseModelSpec(ref, this.providerIds);
        return { provider: parsed.provider ?? '', model: parsed.model, alias: this.config.defaultAlias };
      });
    } else {
      const exact = [];
      const partial = [];
      for (const provider of this.readyProviders()) {
        for (const model of provider.models) {
          if (model.id === spec.model) exact.push({ provider: provider.id, model: model.id });
          else if (model.id.toLowerCase().includes(spec.model.toLowerCase())) {
            partial.push({ provider: provider.id, model: model.id });
          }
        }
      }
      refs = exact.length ? exact : partial.slice(0, 3);
    }

    const seen = new Set();
    /** @type {Candidate[]} */
    const candidates = [];
    for (const ref of refs) {
      const provider = this.providers.get(ref.provider);
      if (!provider || !provider.configured) continue;
      if (!ref.model) continue;
      const key = `${ref.provider}/${ref.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ provider: ref.provider, model: ref.model, ...(ref.alias ? { alias: ref.alias } : {}) });
    }
    return candidates;
  }

  /**
   * Try candidates in order until one answers.
   *
   * @param {any} payload OpenAI-shaped request body
   * @param {{candidates:Candidate[], stream?:boolean, signal?:AbortSignal}} options
   */
  async chat(payload, options) {
    const { candidates, stream = false, signal } = options;
    const startedAt = Date.now();
    /** @type {any[]} */
    const attempts = [];
    let realAttempts = 0;
    let lastError = /** @type {string|null} */ (null);
    let lastStatus = /** @type {number|null} */ (null);

    for (const candidate of candidates) {
      if (realAttempts >= this.config.maxAttempts) break;
      if (signal?.aborted) break;

      const provider = this.providers.get(candidate.provider);
      if (!provider || !provider.configured) continue;

      const keyEntry = provider.pool.pick();
      if (!keyEntry) {
        const wait = provider.pool.waitMs();
        attempts.push({
          provider: provider.id,
          model: candidate.model,
          skipped: true,
          status: 429,
          ms: 0,
          error: `all keys cooling down (${formatDuration(wait)})`
        });
        lastError = `Every key for ${provider.label} is rate limited — retry in ${formatDuration(wait)}`;
        lastStatus = 429;
        log.warn(`[${provider.id}] skipped: all keys cooling down for ${formatDuration(wait)}`);
        continue;
      }

      realAttempts++;
      const attemptStart = Date.now();
      const controller = new AbortController();
      const connectTimer = setTimeout(
        () => controller.abort(new Error(`connect timeout after ${this.config.connectTimeoutMs}ms`)),
        this.config.connectTimeoutMs
      );
      /** @type {NodeJS.Timeout|null} */
      let totalTimer = null;
      if (!stream) {
        totalTimer = setTimeout(
          () => controller.abort(new Error(`request timeout after ${this.config.requestTimeoutMs}ms`)),
          this.config.requestTimeoutMs
        );
      }

      try {
        const upstream = await callProvider({
          provider,
          key: keyEntry.key,
          model: candidate.model,
          payload,
          stream,
          signal: combineSignals([signal, controller.signal])
        });

        clearTimeout(connectTimer);
        const ms = Date.now() - attemptStart;

        if (!upstream.ok) {
          const text = await upstream.text().catch(() => '');
          clearTimeout(totalTimer);
          const message = extractProviderError(text) || `HTTP ${upstream.status}`;
          const kind = classifyStatus(upstream.status, this.config.cooldowns);
          const retryHint = parseRetryAfter(upstream.headers);
          const cooldown = retryHint && kind.retryable ? Math.max(retryHint, kind.cooldownMs) : kind.cooldownMs;
          const applied = provider.pool.markFailure(keyEntry, {
            cooldownMs: cooldown,
            status: upstream.status,
            error: message,
            penalize: kind.penalize
          });

          attempts.push({
            provider: provider.id,
            model: candidate.model,
            status: upstream.status,
            ms,
            error: message,
            cooldownMs: applied,
            type: kind.type
          });
          lastError = message;
          lastStatus = upstream.status;
          log.warn(`[${provider.id}] ${upstream.status} ${candidate.model}: ${message}`);
          continue;
        }

        if (stream) {
          provider.pool.markSuccess(keyEntry, ms);
          return {
            ok: true,
            kind: 'stream',
            upstream,
            provider,
            model: candidate.model,
            candidates,
            keyEntry,
            attempts,
            ms,
            startedAt
          };
        }

        const text = await upstream.text();
        clearTimeout(totalTimer);

        /** @type {any} */
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          const applied = provider.pool.markFailure(keyEntry, {
            cooldownMs: this.config.cooldowns.server,
            status: upstream.status,
            error: 'invalid JSON from provider'
          });
          attempts.push({
            provider: provider.id,
            model: candidate.model,
            status: 502,
            ms: Date.now() - attemptStart,
            error: 'Provider returned a non-JSON body',
            cooldownMs: applied
          });
          lastError = 'Provider returned a non-JSON body';
          lastStatus = 502;
          continue;
        }

        // Some gateways answer 200 with an error envelope (OpenRouter does).
        if (json?.error || !Array.isArray(json?.choices)) {
          const message = extractProviderError(json) || 'Provider returned no choices';
          const applied = provider.pool.markFailure(keyEntry, {
            cooldownMs: this.config.cooldowns.server,
            status: upstream.status,
            error: message
          });
          attempts.push({
            provider: provider.id,
            model: candidate.model,
            status: 502,
            ms: Date.now() - attemptStart,
            error: message,
            cooldownMs: applied
          });
          lastError = message;
          lastStatus = 502;
          log.warn(`[${provider.id}] bad payload on ${candidate.model}: ${message}`);
          continue;
        }

        provider.pool.markSuccess(keyEntry, ms);
        return {
          ok: true,
          kind: 'json',
          json,
          provider,
          model: candidate.model,
          candidates,
          keyEntry,
          attempts,
          ms,
          startedAt,
          promptTokens: Number(json?.usage?.prompt_tokens ?? 0),
          completionTokens: Number(json?.usage?.completion_tokens ?? 0)
        };
      } catch (error) {
        clearTimeout(connectTimer);
        clearTimeout(totalTimer);

        if (signal?.aborted) {
          attempts.push({
            provider: provider.id,
            model: candidate.model,
            status: 499,
            ms: Date.now() - attemptStart,
            error: 'client closed the connection'
          });
          return { ok: false, aborted: true, attempts, error: 'client closed the connection', status: 499, startedAt };
        }

        const err = /** @type {any} */ (error);
        const message = err?.cause?.message || err?.message || String(error);
        const applied = provider.pool.markFailure(keyEntry, {
          cooldownMs: this.config.cooldowns.network,
          status: null,
          error: message
        });
        attempts.push({
          provider: provider.id,
          model: candidate.model,
          status: null,
          ms: Date.now() - attemptStart,
          error: message,
          cooldownMs: applied,
          type: 'network'
        });
        lastError = message;
        lastStatus = 502;
        log.warn(`[${provider.id}] network failure: ${message}`);
      } finally {
        clearTimeout(connectTimer);
        if (totalTimer) clearTimeout(totalTimer);
      }
    }

    return {
      ok: false,
      attempts,
      error: lastError || 'No provider could serve this request',
      status: lastStatus || 503,
      startedAt
    };
  }

  /** Secret-free provider table for the dashboard and /api/status. */
  status() {
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      label: provider.label,
      style: provider.style,
      docs: provider.docs,
      free: provider.free,
      enabled: provider.enabled,
      configured: provider.configured,
      requiresKey: provider.requiresKey,
      baseUrl: provider.baseUrl,
      models: provider.models.map((m) => ({ id: m.id, tags: m.tags || [] })),
      keys: provider.pool.snapshot()
    }));
  }

  /** OpenAI `/v1/models` payload: aliases plus every concrete model. */
  modelsPayload() {
    /** @type {any[]} */
    const data = [];
    const created = Math.floor(Date.now() / 1000);

    const aliases = Object.entries(this.config.aliases);
    for (const [name, refs] of aliases) {
      const candidates = this.candidatesFor(name);
      data.push({
        id: name,
        object: 'model',
        created,
        owned_by: 'router',
        router: { type: 'alias', candidates: candidates.map((c) => `${c.provider}/${c.model}`), available: candidates.length > 0 }
      });
    }

    for (const provider of this.readyProviders()) {
      for (const model of provider.models) {
        data.push({
          id: `${provider.id}/${model.id}`,
          object: 'model',
          created,
          owned_by: provider.id,
          router: { type: 'model', provider: provider.id, model: model.id, tags: model.tags || [] }
        });
      }
    }

    return { object: 'list', data };
  }

  resetCooldowns() {
    for (const provider of this.providers.values()) provider.pool.reset();
  }
}
