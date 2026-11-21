import * as anthropic from './anthropic.js';
import * as openai from './openai.js';

/**
 * Send one attempt to one provider and return an OpenAI-shaped Response.
 *
 * @param {{provider:any, key:string, model:string, payload:any, stream:boolean, signal?:AbortSignal}} ctx
 * @returns {Promise<Response>}
 */
export function callProvider(ctx) {
  if (ctx.provider.style === 'anthropic') return anthropic.call(ctx);
  return openai.call(ctx);
}

export { anthropic, openai };
