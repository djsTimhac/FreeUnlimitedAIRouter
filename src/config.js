import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { interpolate } from './env.js';
import { DEFAULT_ALIASES, PROVIDER_CATALOG } from './providers/catalog.js';

/** @typedef {import('./providers/catalog.js').ModelDef} ModelDef */

/**
 * Split one or more raw env values into a clean, de-duplicated key list.
 * Accepts comma, semicolon, whitespace and newline separators.
 * @param {...(string|string[]|undefined)} values
 * @returns {string[]}
 */
export function parseKeyList(...values) {
  const keys = [];
  for (const value of values) {
    if (!value) continue;
    const parts = Array.isArray(value) ? value : [value];
    for (const part of parts) {
      for (const token of String(part).split(/[\s,;]+/)) {
        const key = token.trim();
        if (key && !keys.includes(key)) keys.push(key);
      }
    }
  }
  return keys;
}

/**
 * Accept `["model-a", {id:"model-b", tags:[...]}]` and return ModelDef[].
 * @param {unknown} input
 * @returns {ModelDef[]}
 */
export function normalizeModels(input) {
  if (!Array.isArray(input)) return [];
  const models = [];
  for (const entry of input) {
    if (typeof entry === 'string' && entry.trim()) {
      models.push({ id: entry.trim(), tags: [] });
    } else if (entry && typeof entry === 'object' && typeof (/** @type {any} */ (entry).id) === 'string') {
      const model = /** @type {any} */ (entry);
      models.push({ id: model.id.trim(), tags: Array.isArray(model.tags) ? model.tags : [] });
    }
  }
  // Last definition wins, but keep original order.
  const seen = new Set();
  return models.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

/**
 * Build one runnable provider from catalog defaults + config overrides + env.
 * @param {any} def
 * @param {any} override
 * @param {Record<string,string|undefined>} env
 */
export function buildProvider(def, override, env) {
  const label = override.label ?? (def.labelEnv ? env[def.labelEnv] : null) ?? def.label;
  const rawBaseUrl = override.baseUrl ?? (def.baseUrlEnv ? env[def.baseUrlEnv] : null) ?? def.baseUrl ?? '';
  const baseUrl = String(interpolate(rawBaseUrl, env) || '').replace(/\/+$/, '');

  const requiresKey = override.requiresKey ?? def.requiresKey ?? true;

  let keys = [];
  if (Array.isArray(override.keys)) {
    keys = parseKeyList(override.keys.map((k) => interpolate(k, env)));
  } else if (override.apiKey) {
    keys = parseKeyList(String(interpolate(override.apiKey, env)));
  }
  if (!keys.length && def.apiKeyEnv && env[def.apiKeyEnv]) {
    keys = parseKeyList(String(interpolate(env[def.apiKeyEnv], env)));
  }
  if (!keys.length) {
    keys = parseKeyList(...(def.env || []).map((name) => env[name]));
  }
  if (!keys.length && !requiresKey) keys = [''];

  const envModels = def.modelsEnv ? parseKeyList(env[def.modelsEnv]) : [];
  const modelsSource = override.models ? normalizeModels(override.models) : [];
  const models = modelsSource.length
    ? modelsSource
    : envModels.length
      ? envModels.map((id) => ({ id, tags: ['free'] }))
      : def.models.map((m) => ({ id: m.id, tags: [...(m.tags || [])] }));

  const headers = {
    ...(def.headers || {}),
    ...(override.headers || {})
  };

  // Local runtimes (Ollama, LM Studio) are off unless they were pointed at
  // explicitly — otherwise every request wastes two attempts on a closed port.
  const explicitBase = Boolean(override.baseUrl || (def.baseUrlEnv && env[def.baseUrlEnv]));
  const enabled =
    override.enabled === true
      ? true
      : override.disabled === true || override.enabled === false || def.defaultEnabled === false
        ? explicitBase
        : true;
  const configured = enabled && Boolean(baseUrl) && (keys.length > 0);

  return {
    id: def.id,
    label,
    docs: def.docs ?? null,
    style: override.style ?? def.style ?? 'openai',
    baseUrl,
    headers,
    keys,
    free: override.free ?? def.free ?? false,
    requiresKey,
    enabled,
    configured,
    models
  };
}

/**
 * Aliases are ordered candidate lists of `provider/model` strings.
 * `free` and `all` are generated; everything else starts from the catalog
 * defaults and is then replaced by whatever the user put in the config file.
 *
 * @param {{id:string, models:ModelDef[], free:boolean}[]} providers
 * @param {Record<string, string[]>} [overrides]
 * @returns {Record<string, string[]>}
 */
export function buildAliases(providers, overrides = {}) {
  /** @type {Record<string, string[]>} */
  const aliases = {};

  const free = [];
  const all = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      const ref = `${provider.id}/${model.id}`;
      all.push(ref);
      // Only an explicit `free` tag counts. A provider can have a free tier and
      // still serve paid models, so the provider flag alone is not enough.
      if ((model.tags || []).includes('free')) free.push(ref);
    }
  }
  aliases.free = free;
  aliases.all = all;

  for (const [name, list] of Object.entries(DEFAULT_ALIASES)) {
    aliases[name] = [...list];
  }
  for (const [name, list] of Object.entries(overrides)) {
    if (Array.isArray(list) && list.length) aliases[name] = list.map(String);
  }
  return aliases;
}

/**
 * @param {Record<string, unknown>} configFile
 * @param {Record<string, string|undefined>} env
 */
function mergeProviders(configFile, env) {
  /** @type {Record<string, any>} */
  const overrides = (configFile.providers && typeof configFile.providers === 'object') ? configFile.providers : {};
  /** @type {any[]} */
  const providers = [];

  const known = new Set();
  for (const def of PROVIDER_CATALOG) {
    known.add(def.id);
    const override = overrides[def.id] && typeof overrides[def.id] === 'object' ? overrides[def.id] : {};
    providers.push(buildProvider(def, override, env));
  }

  // Providers that only exist in router.config.json.
  for (const [id, override] of Object.entries(overrides)) {
    if (known.has(id) || !override || typeof override !== 'object') continue;
    const def = {
      id,
      label: id,
      docs: null,
      style: 'openai',
      baseUrl: '',
      env: [],
      free: true,
      requiresKey: true,
      models: []
    };
    providers.push(buildProvider(def, override, env));
  }

  // Keep only providers that can actually serve something.
  return providers.filter((p) => p.baseUrl && p.models.length > 0);
}

/**
 * Read the optional `router.config.json`.
 * @param {string|undefined} path
 * @returns {Record<string, any>}
 */
export function readConfigFile(path) {
  if (!path || !existsSync(path)) return {};
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${/** @type {Error} */ (error).message}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object at the top level');
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${/** @type {Error} */ (error).message}`);
  }
}

/**
 * Full runtime configuration: env first, config file second.
 *
 * @param {{env?: Record<string,string|undefined>, configPath?: string|null, cwd?: string}} [options]
 */
export function loadConfig(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath === null
    ? null
    : resolve(cwd, options.configPath ?? env.CONFIG_PATH ?? 'router.config.json');

  const configFile = readConfigFile(configPath ?? undefined);
  const providers = mergeProviders(configFile, env);

  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  const aliases = buildAliases(providers, configFile.aliases || {});

  return {
    configPath: configPath && existsSync(configPath) ? configPath : null,
    host: env.HOST || '0.0.0.0',
    port: num(env.PORT, 8787),
    apiKey: env.ROUTER_API_KEY || '',
    dashboard: env.DISABLE_DASHBOARD !== '1',
    defaultAlias: configFile.defaultAlias || env.DEFAULT_ALIAS || 'free',
    maxAttempts: num(configFile.maxAttempts ?? env.MAX_ATTEMPTS, 6),
    connectTimeoutMs: num(env.CONNECT_TIMEOUT_MS, 20_000),
    requestTimeoutMs: num(env.REQUEST_TIMEOUT_MS, 180_000),
    maxBodyBytes: num(env.MAX_BODY_BYTES, 10 * 1024 * 1024),
    corsOrigin: env.CORS_ORIGIN || '*',
    logLevel: env.LOG_LEVEL || 'info',
    cooldowns: {
      rateLimit: num(env.COOLDOWN_RATE_LIMIT_MS, 60_000),
      auth: num(env.COOLDOWN_AUTH_MS, 600_000),
      server: num(env.COOLDOWN_SERVER_MS, 15_000),
      network: num(env.COOLDOWN_NETWORK_MS, 10_000),
      payment: num(env.COOLDOWN_PAYMENT_MS, 3_600_000)
    },
    providers,
    aliases
  };
}
