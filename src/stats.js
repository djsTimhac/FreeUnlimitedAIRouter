/** In-memory counters. Everything resets when the process restarts. */

const MAX_RECENT = 120;

export class Stats {
  constructor() {
    this.startedAt = Date.now();
    this.totals = {
      requests: 0,
      ok: 0,
      failed: 0,
      streamed: 0,
      promptTokens: 0,
      completionTokens: 0,
      fallbacks: 0
    };
    /** @type {Map<string, any>} */
    this.byProvider = new Map();
    /** @type {any[]} */
    this.recent = [];
  }

  /**
   * @param {{provider:string, model:string, ok:boolean, status?:number|null, ms:number,
   *          promptTokens?:number, completionTokens?:number, stream?:boolean,
   *          attempts?:number, error?:string|null, requested?:string}} entry
   */
  record(entry) {
    const promptTokens = entry.promptTokens || 0;
    const completionTokens = entry.completionTokens || 0;

    this.totals.requests++;
    if (entry.ok) this.totals.ok++;
    else this.totals.failed++;
    if (entry.stream) this.totals.streamed++;
    if ((entry.attempts || 1) > 1) this.totals.fallbacks++;
    this.totals.promptTokens += promptTokens;
    this.totals.completionTokens += completionTokens;

    const key = entry.provider || 'unknown';
    const provider = this.byProvider.get(key) || {
      requests: 0,
      ok: 0,
      failed: 0,
      totalMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      lastError: null,
      lastUsedAt: 0
    };
    provider.requests++;
    if (entry.ok) provider.ok++;
    else {
      provider.failed++;
      provider.lastError = entry.error ? String(entry.error).slice(0, 300) : null;
    }
    provider.totalMs += entry.ms || 0;
    provider.promptTokens += promptTokens;
    provider.completionTokens += completionTokens;
    provider.lastUsedAt = Date.now();
    this.byProvider.set(key, provider);

    this.recent.unshift({
      at: Date.now(),
      provider: entry.provider || 'unknown',
      model: entry.model || '',
      requested: entry.requested || '',
      ok: Boolean(entry.ok),
      status: entry.status ?? null,
      ms: entry.ms || 0,
      stream: Boolean(entry.stream),
      attempts: entry.attempts || 1,
      tokens: promptTokens + completionTokens,
      error: entry.error ? String(entry.error).slice(0, 300) : null
    });
    if (this.recent.length > MAX_RECENT) this.recent.length = MAX_RECENT;
  }

  snapshot() {
    const uptimeMs = Date.now() - this.startedAt;
    const providers = {};
    for (const [id, p] of this.byProvider) {
      providers[id] = {
        requests: p.requests,
        ok: p.ok,
        failed: p.failed,
        avgMs: p.requests ? Math.round(p.totalMs / p.requests) : 0,
        promptTokens: p.promptTokens,
        completionTokens: p.completionTokens,
        lastError: p.lastError,
        lastUsedAt: p.lastUsedAt
      };
    }
    return {
      startedAt: this.startedAt,
      uptimeMs,
      successRate: this.totals.requests
        ? Math.round((this.totals.ok / this.totals.requests) * 1000) / 10
        : null,
      totals: { ...this.totals },
      providers,
      recent: this.recent.slice(0, 50)
    };
  }

  reset() {
    this.totals = {
      requests: 0,
      ok: 0,
      failed: 0,
      streamed: 0,
      promptTokens: 0,
      completionTokens: 0,
      fallbacks: 0
    };
    this.byProvider.clear();
    this.recent = [];
  }
}
