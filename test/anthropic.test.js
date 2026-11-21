import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fromAnthropicResponse,
  mapStopReason,
  toAnthropicPayload,
  translateStream
} from '../src/providers/anthropic.js';

test('toAnthropicPayload lifts system messages and keeps alternating roles', () => {
  const body = toAnthropicPayload(
    {
      model: 'claude-test',
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'system', content: 'Answer in German.' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hallo' },
        { role: 'user', content: 'Wie geht es dir?' }
      ]
    },
    'claude-test',
    false
  );

  assert.equal(body.system, 'You are terse.\n\nAnswer in German.');
  assert.deepEqual(body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'Hi' }]);
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.stream, false);
});

test('toAnthropicPayload merges consecutive same-role turns and prepends a user turn', () => {
  const body = toAnthropicPayload(
    {
      messages: [
        { role: 'assistant', content: 'I speak first' },
        { role: 'user', content: 'one' },
        { role: 'user', content: 'two' }
      ]
    },
    'claude-test',
    false
  );

  assert.equal(body.messages[0].role, 'user');
  assert.equal(body.messages[0].content[0].text, 'Continue.');
  assert.equal(body.messages[2].role, 'user');
  assert.equal(body.messages[2].content.length, 2);
});

test('toAnthropicPayload converts tools, tool calls and tool results', () => {
  const body = toAnthropicPayload(
    {
      max_tokens: 256,
      temperature: 0.2,
      stop: ['END'],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'Weather lookup', parameters: { type: 'object', properties: { city: { type: 'string' } } } }
        }
      ],
      tool_choice: 'required',
      messages: [
        { role: 'user', content: 'Weather in Berlin?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Berlin"}' } }
          ]
        },
        { role: 'tool', tool_call_id: 'call_1', content: '18°C, sunny' }
      ]
    },
    'claude-test',
    true
  );

  assert.equal(body.max_tokens, 256);
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(body.stop_sequences, ['END']);
  assert.deepEqual(body.tool_choice, { type: 'any' });
  assert.equal(body.tools[0].name, 'get_weather');
  assert.deepEqual(body.tools[0].input_schema, { type: 'object', properties: { city: { type: 'string' } } });
  assert.deepEqual(body.messages[1].content[0], {
    type: 'tool_use',
    id: 'call_1',
    name: 'get_weather',
    input: { city: 'Berlin' }
  });
  assert.deepEqual(body.messages[2].content[0], {
    type: 'tool_result',
    tool_use_id: 'call_1',
    content: '18°C, sunny'
  });
});

test('toAnthropicPayload converts image data URLs', () => {
  const body = toAnthropicPayload(
    {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
          ]
        }
      ]
    },
    'claude-test',
    false
  );

  assert.deepEqual(body.messages[0].content[1], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }
  });
});

test('fromAnthropicResponse produces an OpenAI completion with tool calls', () => {
  const completion = fromAnthropicResponse(
    {
      id: 'msg_123',
      content: [
        { type: 'text', text: 'Checking…' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Berlin' } }
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 12, output_tokens: 7 }
    },
    'smart'
  );

  assert.equal(completion.object, 'chat.completion');
  assert.equal(completion.model, 'smart');
  assert.equal(completion.choices[0].finish_reason, 'tool_calls');
  assert.equal(completion.choices[0].message.content, 'Checking…');
  assert.equal(completion.choices[0].message.tool_calls[0].function.name, 'get_weather');
  assert.deepEqual(JSON.parse(completion.choices[0].message.tool_calls[0].function.arguments), { city: 'Berlin' });
  assert.deepEqual(completion.usage, { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 });
});

test('mapStopReason covers the Anthropic reasons', () => {
  assert.equal(mapStopReason('end_turn'), 'stop');
  assert.equal(mapStopReason('max_tokens'), 'length');
  assert.equal(mapStopReason('tool_use'), 'tool_calls');
  assert.equal(mapStopReason(null), null);
});

test('translateStream emits OpenAI chunks including tool deltas', async () => {
  const encoder = new TextEncoder();
  const events = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ];

  const upstream = new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    }
  });

  const text = await new Response(translateStream(upstream, 'claude-test')).text();
  const frames = text
    .split('\n\n')
    .map((block) => block.replace(/^data: /, '').trim())
    .filter(Boolean)
    .filter((payload) => payload !== '[DONE]')
    .map((payload) => JSON.parse(payload));

  assert.equal(frames[0].choices[0].delta.role, 'assistant');
  assert.equal(frames[0].model, 'claude-test');
  const content = frames
    .map((frame) => frame.choices?.[0]?.delta?.content)
    .filter((value) => typeof value === 'string')
    .join('');
  assert.equal(content, 'Hello world');
  assert.equal(frames.at(-1).choices[0].finish_reason, 'stop');
  assert.deepEqual(frames.at(-1).usage, { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 });
  assert.ok(text.endsWith('data: [DONE]\n\n'));
});
