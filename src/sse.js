/**
 * Small Server-Sent-Events helpers. Providers do not all follow the spec
 * identically (blank-line termination, `event:` lines, CRLF), so parsing is
 * deliberately forgiving.
 */

/**
 * Incremental SSE line splitter.
 * Feed it raw chunks; pull complete events out.
 */
export class SseParser {
  /** @param {string} [delimiter] */
  constructor(delimiter = '\n\n') {
    this.delimiter = delimiter;
    this.buffer = '';
  }

  /**
   * @param {string} chunk
   * @returns {string[]} complete event blocks
   */
  push(chunk) {
    this.buffer += chunk;
    // Normalise CRLF so the delimiter check is simple.
    this.buffer = this.buffer.replace(/\r\n/g, '\n');
    const blocks = [];
    let index;
    while ((index = this.buffer.indexOf(this.delimiter)) !== -1) {
      blocks.push(this.buffer.slice(0, index));
      this.buffer = this.buffer.slice(index + this.delimiter.length);
    }
    return blocks;
  }

  /** Anything left when the stream ends. */
  flush() {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest ? [rest] : [];
  }
}

/**
 * @param {string} block
 * @returns {{event:string|null, data:any, raw:string}|null}
 */
export function parseSseBlock(block) {
  let event = null;
  const dataLines = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (!dataLines.length) return null;

  const raw = dataLines.join('\n');
  let data = raw;
  try {
    data = JSON.parse(raw);
  } catch {
    /* plain text payload — keep it as a string */
  }
  return { event, data, raw };
}

/**
 * Format an OpenAI chat.completion.chunk as an SSE frame.
 * @param {unknown} payload
 */
export function openAiChunkFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const SSE_DONE = 'data: [DONE]\n\n';
