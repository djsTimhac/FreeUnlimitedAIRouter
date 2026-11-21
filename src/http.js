import { once } from 'node:events';

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string,string|number>} [headers]
 */
export function sendJson(res, status, body, headers = {}) {
  if (res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers
  });
  res.end(text);
}

/**
 * OpenAI-shaped error envelope so existing SDKs decode it without surprises.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} message
 * @param {{type?:string, code?:string|null, hint?:string, headers?:Record<string,string|number>}} [options]
 */
export function sendError(res, status, message, options = {}) {
  const { type = 'invalid_request_error', code = null, hint = null, headers = {} } = options;
  sendJson(
    res,
    status,
    { error: { message, type, code, ...(hint ? { hint } : {}) } },
    headers
  );
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<any>}
 */
export async function readJsonBody(req, limit = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error(`Request body exceeds ${limit} bytes`);
      // @ts-expect-error custom status
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('Malformed JSON in request body');
    // @ts-expect-error custom status
    error.status = 400;
    throw error;
  }
}

/**
 * Copy a web ReadableStream into a Node response while tapping every chunk.
 * @param {import('node:http').ServerResponse} res
 * @param {ReadableStream<Uint8Array>|null} body
 * @param {(chunk: Uint8Array) => void} [onChunk]
 */
export async function pipeStream(res, body, onChunk) {
  if (!body) {
    res.end();
    return;
  }
  try {
    for await (const chunk of /** @type {any} */ (body)) {
      if (res.writableEnded || res.destroyed) break;
      onChunk?.(chunk);
      if (!res.write(chunk)) await once(res, 'drain');
    }
  } finally {
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}

/**
 * @param {Array<AbortSignal|undefined>} signals
 * @returns {AbortSignal|undefined}
 */
export function combineSignals(signals) {
  const list = signals.filter(Boolean).filter((s) => !s?.aborted);
  const alreadyAborted = signals.filter(Boolean).find((s) => s?.aborted);
  if (alreadyAborted) return alreadyAborted;
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const signal of list) signal.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

/**
 * @param {string|undefined} a
 * @param {string|undefined} b
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
