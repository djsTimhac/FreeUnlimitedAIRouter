import { existsSync, readFileSync } from 'node:fs';

/**
 * Minimal `.env` reader. Node has `--env-file` and `process.loadEnvFile()`, but
 * not on every version we support, and a 25-line parser keeps `npm start` free
 * of flags.
 *
 * Rules: `KEY=value`, optional surrounding quotes, `#` comments, never
 * overwrites a variable that is already set in the environment.
 *
 * @param {string} file
 * @param {Record<string, string|undefined>} [env]
 * @returns {number} number of variables set
 */
export function loadDotEnv(file, env = process.env) {
  if (!file || !existsSync(file)) return 0;

  let count = 0;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    if (!key) continue;
    if (env[key] === undefined || env[key] === '') {
      env[key] = value;
      count++;
    }
  }
  return count;
}

/**
 * Replace `${VAR}` / `$VAR` placeholders from the environment.
 * @param {unknown} value
 * @param {Record<string, string|undefined>} env
 */
export function interpolate(value, env) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/g, (_, a, b) => env[a || b] ?? '');
}
