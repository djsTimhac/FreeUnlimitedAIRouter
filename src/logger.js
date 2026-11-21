const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

let threshold = LEVELS.info;

/** @param {string} name */
export function setLogLevel(name) {
  threshold = LEVELS[name] ?? LEVELS.info;
}

export function currentLogLevel() {
  return Object.keys(LEVELS).find((k) => LEVELS[k] === threshold) ?? 'info';
}

/**
 * @param {'error'|'warn'|'info'|'debug'} level
 * @param {string} message
 * @param {Record<string, unknown>|Error} [extra]
 */
function write(level, message, extra) {
  if (LEVELS[level] > threshold) return;

  let suffix = '';
  if (extra instanceof Error) {
    suffix = ` ${extra.message}`;
    if (extra.stack && level === 'debug') suffix += `\n${extra.stack}`;
  } else if (extra) {
    try {
      suffix = ` ${JSON.stringify(extra)}`;
    } catch {
      suffix = ' [unserializable]';
    }
  }

  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${suffix}\n`;
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line);
}

export const log = {
  /** @param {string} m @param {any} [e] */
  error: (m, e) => write('error', m, e),
  /** @param {string} m @param {any} [e] */
  warn: (m, e) => write('warn', m, e),
  /** @param {string} m @param {any} [e] */
  info: (m, e) => write('info', m, e),
  /** @param {string} m @param {any} [e] */
  debug: (m, e) => write('debug', m, e)
};
