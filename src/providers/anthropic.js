import { SSE_DONE, SseParser, openAiChunkFrame, parseSseBlock } from '../sse.js';
import { USER_AGENT } from './openai.js';

export const ANTHROPIC_VERSION = '2023-06-01';

/** @type {Record<string, string>} */
const STOP_REASONS = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  pause_turn: 'stop',
  refusal: 'content_filter'
};

/** @param {string|null|undefined} reason */
export function mapStopReason(reason) {
  if (!reason) return null;
  return STOP_REASONS[reason] ?? 'stop';
}

/** @param {unknown} value */
function asText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text ?? '') : ''))
      .join('');
  }
  return '';
}

/** @param {unknown} content */
function toBlocks(content) {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  /** @type {any[]} */
  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const item = /** @type {any} */ (part);

    if (item.type === 'text' || typeof item.text === 'string') {
      blocks.push({ type: 'text', text: String(item.text ?? '') });
    } else if (item.type === 'image_url') {
      const url = typeof item.image_url === 'string' ? item.image_url : item.image_url?.url;
      const image = imageBlockFromUrl(url);
      if (image) blocks.push(image);
    } else if (item.type === 'image' && item.source) {
      blocks.push({ type: 'image', source: item.source });
    }
  }
  return blocks;
}

/** @param {string|undefined} url */
function imageBlockFromUrl(url) {
  if (!url) return null;
  const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (dataUrl) {
    return { type: 'image', source: { type: 'base64', media_type: dataUrl[1], data: dataUrl[2] } };
  }
  return { type: 'image', source: { type: 'url', url } };
}

/** @param {unknown} value */
function parseJsonObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Convert an OpenAI chat request into an Anthropic Messages request.
 *
 * @param {any} payload
 * @param {string} model
 * @param {boolean} stream
 */
export function toAnthropicPayload(payload, model, stream) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  /** @type {string[]} */
  const system = [];
  /** @type {{role:string, content:any[]}[]} */
  const converted = [];

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role;

    if (role === 'system' || role === 'developer') {
      const text = asText(message.content);
      if (text) system.push(text);
      continue;
    }

    if (role === 'tool' || role === 'function') {
      converted.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: String(message.tool_call_id || message.name || 'tool_call'),
            content: asText(message.content) || JSON.stringify(message.content ?? '')
          }
        ]
      });
      continue;
    }

    if (role === 'assistant') {
      /** @type {any[]} */
      const blocks = [];
      const text = asText(message.content);
      if (text) blocks.push({ type: 'text', text });
      for (const call of message.tool_calls || []) {
        const fn = call?.function || {};
        blocks.push({
          type: 'tool_use',
          id: String(call?.id || `toolu_${Math.random().toString(36).slice(2, 12)}`),
          name: String(fn.name || 'tool'),
          input: parseJsonObject(fn.arguments)
        });
      }
      if (!blocks.length) blocks.push({ type: 'text', text: '' });
      converted.push({ role: 'assistant', content: blocks });
      continue;
    }

    const blocks = toBlocks(message.content);
    if (blocks.length) converted.push({ role: 'user', content: blocks });
  }

  // Anthropic requires alternating roles and a leading user turn.
  /** @type {{role:string, content:any[]}[]} */
  const merged = [];
  for (const message of converted) {
    const previous = merged[merged.length - 1];
    if (previous && previous.role === message.role) {
      previous.content = [...previous.content, ...message.content];
    } else {
      merged.push({ role: message.role, content: [...message.content] });
    }
  }
  if (merged.length && merged[0].role !== 'user') {
    merged.unshift({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });
  }
  if (!merged.length) merged.push({ role: 'user', content: [{ type: 'text', text: '' }] });

  /** @type {any[]} */
  const tools = [];
  for (const tool of payload?.tools || []) {
    const fn = tool?.function || tool;
    if (!fn?.name) continue;
    tools.push({
      name: String(fn.name),
      description: fn.description ? String(fn.description) : undefined,
      input_schema: fn.parameters && typeof fn.parameters === 'object'
        ? fn.parameters
        : { type: 'object', properties: {} }
    });
  }

  /** @type {any} */
  const body = {
    model,
    messages: merged,
    max_tokens: Number(payload?.max_tokens ?? payload?.max_completion_tokens ?? 4096),
    stream
  };

  if (system.length) body.system = system.join('\n\n');
  if (typeof payload?.temperature === 'number') body.temperature = payload.temperature;
  if (typeof payload?.top_p === 'number') body.top_p = payload.top_p;
  if (Array.isArray(payload?.stop) && payload.stop.length) body.stop_sequences = payload.stop;
  else if (typeof payload?.stop === 'string') body.stop_sequences = [payload.stop];

  if (tools.length) {
    body.tools = tools;
    const choice = payload?.tool_choice;
    if (typeof choice === 'string') {
      if (choice === 'required') body.tool_choice = { type: 'any' };
      else if (choice === 'auto') body.tool_choice = { type: 'auto' };
      // "none" → simply keep the tools available but do not force them.
    } else if (choice && typeof choice === 'object' && choice.function?.name) {
      body.tool_choice = { type: 'tool', name: String(choice.function.name) };
    }
  }

  return body;
}

/**
 * Convert an Anthropic Messages response into an OpenAI chat.completion.
 *
 * @param {any} data
 * @param {string} echoModel
 */
export function fromAnthropicResponse(data, echoModel) {
  const content = Array.isArray(data?.content) ? data.content : [];
  const text = content
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('');

  const toolCalls = content
    .filter((block) => block?.type === 'tool_use')
    .map((block) => ({
      id: String(block.id ?? `call_${Math.random().toString(36).slice(2, 10)}`),
      type: 'function',
      function: {
        name: String(block.name ?? 'tool'),
        arguments: JSON.stringify(block.input ?? {})
      }
    }));

  const promptTokens = Number(data?.usage?.input_tokens ?? 0);
  const completionTokens = Number(data?.usage?.output_tokens ?? 0);

  /** @type {any} */
  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id: `chatcmpl-${String(data?.id ?? Math.random().toString(36).slice(2, 12)).replace(/[^a-zA-Z0-9_-]/g, '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: echoModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? 'tool_calls' : (mapStopReason(data?.stop_reason) ?? 'stop'),
        logprobs: null
      }
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    }
  };
}

/**
 * Translate Anthropic's SSE stream into OpenAI chat.completion.chunk frames.
 *
 * @param {ReadableStream<Uint8Array>|null} body
 * @param {string} echoModel
 * @returns {ReadableStream<Uint8Array>}
 */
export function translateStream(body, echoModel) {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      if (!body) {
        controller.close();
        return;
      }

      const reader = body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      const id = `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;
      const created = Math.floor(Date.now() / 1000);

      let toolIndex = -1;
      let finishReason = null;
      let closed = false;
      const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

      /** @param {any} delta @param {string|null} [finish] @param {any} [extra] */
      const emit = (delta, finish = null, extra = undefined) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(
              openAiChunkFrame({
                id,
                object: 'chat.completion.chunk',
                created,
                model: echoModel,
                choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
                ...(extra ? { usage: extra } : {})
              })
            )
          );
        } catch {
          closed = true;
        }
      };

      /** @param {string} block */
      const handle = (block) => {
        const parsed = parseSseBlock(block);
        if (!parsed || parsed.raw === '[DONE]') return;

        const data = parsed.data;
        if (!data || typeof data !== 'object') return;
        const type = parsed.event || data.type;

        switch (type) {
          case 'message_start':
            usage.prompt_tokens = Number(data.message?.usage?.input_tokens ?? 0);
            emit({ role: 'assistant', content: '' });
            break;

          case 'content_block_start':
            if (data.content_block?.type === 'tool_use') {
              toolIndex += 1;
              emit({
                tool_calls: [
                  {
                    index: toolIndex,
                    id: String(data.content_block.id ?? `call_${toolIndex}`),
                    type: 'function',
                    function: { name: String(data.content_block.name ?? 'tool'), arguments: '' }
                  }
                ]
              });
            }
            break;

          case 'content_block_delta':
            if (data.delta?.type === 'text_delta') {
              emit({ content: String(data.delta.text ?? '') });
            } else if (data.delta?.type === 'input_json_delta' && toolIndex >= 0) {
              emit({
                tool_calls: [
                  { index: toolIndex, function: { arguments: String(data.delta.partial_json ?? '') } }
                ]
              });
            }
            break;

          case 'message_delta':
            if (data.delta?.stop_reason) finishReason = mapStopReason(data.delta.stop_reason);
            if (data.usage?.output_tokens != null) usage.completion_tokens = Number(data.usage.output_tokens);
            break;

          case 'error': {
            const message = data.error?.message || 'Anthropic stream error';
            emit({ content: '' }, null);
            finishReason = 'error';
            try {
              controller.enqueue(
                encoder.encode(
                  openAiChunkFrame({ id, object: 'chat.completion.chunk', created, model: echoModel, choices: [], error: { message, type: 'upstream_error' } })
                )
              );
            } catch {
              closed = true;
            }
            break;
          }

          default:
            break;
        }
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const block of parser.push(decoder.decode(value, { stream: true }))) handle(block);
        }
        for (const block of parser.flush()) handle(block);
      } catch {
        /* upstream died mid-stream — the client sees a clean end below */
      } finally {
        reader.releaseLock();
      }

      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      emit({}, finishReason ?? 'stop', usage);
      if (!closed) {
        try {
          controller.enqueue(encoder.encode(SSE_DONE));
        } catch {
          /* already closed */
        }
      }
      closed = true;
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    }
  });
}

/**
 * @param {{provider:any, key:string, model:string, payload:any, stream:boolean, signal?:AbortSignal}} ctx
 * @returns {Promise<Response>}
 */
export async function call(ctx) {
  const { provider, key, model, payload, stream, signal } = ctx;
  const echoModel = typeof payload?.model === 'string' && payload.model ? payload.model : model;
  const body = toAnthropicPayload(payload, model, stream);

  const headers = {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    'user-agent': USER_AGENT,
    ...(provider.headers || {})
  };
  if (key) headers['x-api-key'] = key;

  const response = await fetch(`${provider.baseUrl}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) return response;

  if (stream) {
    return new Response(translateStream(response.body, echoModel), {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' }
    });
  }

  const data = await response.json();
  return new Response(JSON.stringify(fromAnthropicResponse(data, echoModel)), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}
