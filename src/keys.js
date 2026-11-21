/**
 * Per-key health tracking: round-robin selection, exponential cool-downs and
 * the counters the dashboard shows.
 *
 * The whole point of the router is that one exhausted free key should not take
 * the service down — it should quietly move to the next key, then the next
 * provider.
 */

/**
 * Show only enough of a key to recognise it, never the secret.
 * @param {string} key
 */
export function maskKey(key) {
  if (!key) return '(none)';
  if (key.length <= 10) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}

/**
 * Parse `Retry-After` (seconds or HTTP date) and the RateLimit-Reset family.
 * @param {Headers|Record<string, string|string[]|undefined>} headers
 * @returns {number|null} milliseconds to wait, or null when the provider is silent
 */
export function parseRetryAfter(headers) {
  if (!headers) return null;

  const get = (name) => {
    if (typeof /** @type {any} */ (headers).get === 'function') {
      return /** @type {any} */ (headers).get(name);
    }
    const value = /** @type {any} */ (headers)[name] ?? /** @type {any} */ (headers)[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };

  const retryAfter = get('retry-after');
  if (retryAfter !== null && retryAfter !== undefined && String(retryAfter).trim() !== '') {
    const raw = String(retryAfter).trim();
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds * 1000, 24 * 3600 * 1000));
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 24 * 3600 * 1000));
  }

  // Groq / some gateways: "1s", "6m0s", "120ms"
  const reset = get('x-ratelimit-reset-requests') ?? get('x-ratelimit-reset-tokens');
  if (reset) {
    const text = String(reset).trim();
    let total = 0;
    let matched = false;
    for (const [, amount, unit] of text.matchAll(/([\d.]+)\s*(ms|s|m|h)/g)) {
      matched = true;
      const n = Number(amount);
      total += unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : n * 3_600_000;
    }
    if (matched) return Math.max(0, Math.round(total));
  }

  return null;
}

const MAX_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * @typedef {Object} KeyEntry
 * @property {number} index
 * @property {string} key
 * @property {boolean} present
 * @property {string} label
 * @property {number} cooldownUntil
 * @property {number} strikes
 * @property {number} lastUsedAt
 * @property {number} requests
 * @property {number} successes
 * @property {number} failures
 * @property {number} totalMs
 * @property {string|null} lastError
 * @property {number|null} lastStatus
 */

export class KeyPool {
  /**
   * @param {string} providerId
   * @param {string[]} keys
   */
  constructor(providerId, keys = []) {
    this.providerId = providerId;
    /** @type {KeyEntry[]} */
    this.entries = (keys.length ? keys : ['']).map((key, index) => ({
      index,
      key,
      present: Boolean(key),
      label: key ? `#${index + 1} ${maskKey(key)}` : '#1 (no key)',
      cooldownUntil: 0,
      strikes: 0,
      lastUsedAt: 0,
      requests: 0,
      successes: 0,
      failures: 0,
      totalMs: 0,
      lastError: null,
      lastStatus: null
    }));
  }

  get size() {
    return this.entries.length;
  }

  /** Keys that are not cooling down right now. */
  usable(now = Date.now()) {
    return this.entries.filter((e) => e.cooldownUntil <= now);
  }

  /** Milliseconds until at least one key is usable again (0 when one is ready). */
  waitMs(now = Date.now()) {
    if (this.usable(now).length) return 0;
    const soonest = Math.min(...this.entries.map((e) => e.cooldownUntil));
    return Math.max(0, soonest - now);
  }

  /**
   * Least-recently-used healthy key. Returns null when every key is cooling
   * down, which makes the router fall through to the next provider.
   * @returns {KeyEntry|null}
   */
  pick(now = Date.now()) {
    const usable = this.usable(now);
    if (!usable.length) return null;
    usable.sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.index - b.index);
    const entry = usable[0];
    entry.lastUsedAt = now;
    entry.requests++;
    return entry;
  }

  /** @param {KeyEntry} entry */
  markSuccess(entry, ms = 0) {
    entry.successes++;
    entry.strikes = 0;
    entry.cooldownUntil = 0;
    entry.lastStatus = 200;
    entry.lastError = null;
    entry.totalMs += ms;
  }

  /**
   * @param {KeyEntry} entry
   * @param {{cooldownMs?: number, status?: number, error?: string, penalize?: boolean}} info
   * @returns {number} applied cool-down in ms
   */
  markFailure(entry, info = {}) {
    const { cooldownMs = 15_000, status = null, error = null, penalize = true } = info;
    entry.failures++;
    entry.lastStatus = status;
    entry.lastError = error ? String(error).slice(0, 400) : null;

    if (!penalize || cooldownMs <= 0) return 0;

    entry.strikes = Math.min(entry.strikes + 1, 7);
    const escalated = Math.min(cooldownMs * Math.pow(1.6, entry.strikes - 1), MAX_COOLDOWN_MS);
    entry.cooldownUntil = Date.now() + escalated;
    return Math.round(escalated);
  }

  /** Reset every key (dashboard action / manual recovery). */
  reset() {
    for (const entry of this.entries) {
      entry.cooldownUntil = 0;
      entry.strikes = 0;
      entry.lastError = null;
    }
  }

  /** Public, secret-free view. */
  snapshot() {
    const now = Date.now();
    return {
      size: this.size,
      usable: this.usable(now).length,
      waitMs: this.waitMs(now),
      keys: this.entries.map((e) => ({
        label: e.label,
        present: e.present,
        cooling: e.cooldownUntil > now,
        cooldownMs: Math.max(0, e.cooldownUntil - now),
        strikes: e.strikes,
        requests: e.requests,
        successes: e.successes,
        failures: e.failures,
        avgMs: e.successes ? Math.round(e.totalMs / e.successes) : 0,
        lastStatus: e.lastStatus,
        lastError: e.lastError
      }))
    };
  }
}
