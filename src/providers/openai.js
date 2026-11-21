export const USER_AGENT = 'FreeUnlimitedAIRouter/1.0 (+https://github.com/djsTimhac/FreeUnlimitedAIRouter)';

/**
 * @param {{provider:any, key:string, model:string, payload:any, stream:boolean}} ctx
 */
export function buildRequest(ctx) {
  const { provider, key, model, payload, stream } = ctx;

  const body = { ...payload, model, stream };
  if (!stream) delete body.stream_options;

  const headers = {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    'user-agent': USER_AGENT,
    ...(provider.headers || {})
  };
  if (key) headers.authorization = `Bearer ${key}`;

  return {
    url: `${provider.baseUrl}/chat/completions`,
    headers,
    body
  };
}

/**
 * Fire the request. The caller inspects `response.ok` and decides whether to
 * fall back.
 * @param {{provider:any, key:string, model:string, payload:any, stream:boolean, signal?:AbortSignal}} ctx
 * @returns {Promise<Response>}
 */
export async function call(ctx) {
  const { url, headers, body } = buildRequest(ctx);
  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: ctx.signal
  });
}
