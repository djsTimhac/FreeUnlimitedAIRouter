/**
 * Model reference parsing.
 *
 * The router accepts three shapes:
 *
 *   "free"                              → an alias from router.config.json
 *   "groq/openai/gpt-oss-20b"           → provider prefix, model id with slashes
 *   "openrouter:google/gemma-4:free"    → provider prefix, model id with a colon
 *   "google/gemma-4-31b-it:free"        → plain model id, searched across providers
 *
 * Only a prefix that names an actual provider is treated as a provider prefix,
 * which is why OpenRouter's slashed ids still work unprefixed.
 */

/**
 * @param {string} spec
 * @param {Set<string>|string[]} providerIds
 * @returns {{provider: string|null, model: string}}
 */
export function parseModelSpec(spec, providerIds) {
  const ids = providerIds instanceof Set ? providerIds : new Set(providerIds);
  const value = String(spec ?? '').trim();

  for (const separator of ['/', ':']) {
    const index = value.indexOf(separator);
    if (index <= 0) continue;
    const head = value.slice(0, index);
    if (ids.has(head)) {
      return { provider: head, model: value.slice(index + 1).trim() };
    }
  }
  return { provider: null, model: value };
}

/** Human readable size of a wait. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ''}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
}
