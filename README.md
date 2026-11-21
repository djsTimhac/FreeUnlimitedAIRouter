<div align="center">

# FreeUnlimitedAIRouter

**One OpenAI-compatible endpoint in front of many AI providers.**

Automatic fallback · API-key rotation · rate-limit cool-downs · streaming · live dashboard · zero dependencies

[![CI](https://github.com/djsTimhac/FreeUnlimitedAIRouter/actions/workflows/ci.yml/badge.svg)](https://github.com/djsTimhac/FreeUnlimitedAIRouter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-7c9cff.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.17-5eead4.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/runtime_dependencies-0-brightgreen.svg)](package.json)
[![Website](https://img.shields.io/badge/website-live-5eead4.svg)](https://djsTimhac.github.io/FreeUnlimitedAIRouter/)

</div>

---

Point any OpenAI client at the router once. It decides which provider actually
answers — and when one runs out of quota, gets rate limited or simply is down,
the next one takes over without your application noticing.

```
             ┌──────────────┐
  your app ──▶  :8787/v1/…  ──▶  groq        (free tier)
             │   router     ├──▶  gemini      (free tier)
             └──────────────┘  ├──▶  openrouter  (free models)
                               ├──▶  cerebras    (free tier)
                               └──▶  openai / anthropic / … (paid, if configured)
```

## Features

- **Drop-in OpenAI API** — `POST /v1/chat/completions` and `GET /v1/models`,
  including SSE streaming. Works with the official SDKs, LangChain, LibreChat,
  Cursor, Continue, Cline, Open WebUI and anything else that speaks the protocol.
- **Ordered fallback** — every model name resolves to a list of candidates. A
  429, 401, 5xx, timeout or broken response moves on to the next one.
- **Key rotation** — give a provider several keys (`GROQ_API_KEYS=k1,k2,k3`);
  the router spreads load across them and quarantines the exhausted one.
- **Smart cool-downs** — honours `Retry-After` and `x-ratelimit-reset-*`,
  otherwise backs off exponentially (1× → 1.6× → … → 15 min cap).
- **Aliases** — ask for `free`, `fast`, `smart`, `code`, `vision`, `reasoning`
  or `long` and let the router pick the concrete model.
- **Anthropic translation** — Claude speaks a different dialect; the router
  converts requests, responses, tool calls and streams in both directions.
- **Live dashboard** — provider health, per-key state, latency, token counts and
  a streaming playground at `/`.
- **Zero runtime dependencies** — one Node.js process, no `npm install` needed.
- **Optional auth** — set `ROUTER_API_KEY` to lock `/v1/*` and `/api/*` behind a
  bearer token.

## Quick start

```bash
git clone https://github.com/djsTimhac/FreeUnlimitedAIRouter.git
cd FreeUnlimitedAIRouter
cp .env.example .env        # Windows: copy .env.example .env
```

Open `.env`, paste **one** key (Groq and Google Gemini both have free tiers), then:

```bash
npm start
```

```
  FreeUnlimitedAIRouter v1.0.0
  listening on   http://localhost:8787
  dashboard      http://localhost:8787/
  providers      1 ready / 14 known (1 free tier)
  default alias  free (7 candidate(s))
```

First request:

```bash
curl http://localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"free","messages":[{"role":"user","content":"Say hello in five words."}]}'
```

The reply is a normal OpenAI chat completion with one extra field telling you
what actually served it:

```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "model": "free",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "Hello there, friend!" } }],
  "usage": { "prompt_tokens": 14, "completion_tokens": 6, "total_tokens": 20 },
  "router": { "provider": "groq", "model": "openai/gpt-oss-20b", "attempts": 1, "fallbacks": 0, "requested": "free", "latency_ms": 214 }
}
```

## Supported providers

Every provider is optional — configure what you have. Free tiers are in the
catalog so the `free` alias has something to route to.

| Provider | Env var | Free tier | Key |
| --- | --- | --- | --- |
| OpenRouter | `OPENROUTER_API_KEY` | ✅ `:free` models | <https://openrouter.ai/keys> |
| Groq | `GROQ_API_KEY` | ✅ | <https://console.groq.com/keys> |
| Google Gemini | `GEMINI_API_KEY` | ✅ | <https://aistudio.google.com/apikey> |
| Cerebras | `CEREBRAS_API_KEY` | ✅ | <https://cloud.cerebras.ai/> |
| GitHub Models | `GITHUB_MODELS_TOKEN` | ✅ | [PAT with `models:read`](https://github.com/settings/tokens) |
| Mistral | `MISTRAL_API_KEY` | ✅ | <https://console.mistral.ai/api-keys> |
| Together | `TOGETHER_API_KEY` | ✅ | <https://api.together.xyz/settings/api-keys> |
| Ollama (local) | `OLLAMA_BASE_URL` | ✅ local | — |
| LM Studio (local) | `LMSTUDIO_BASE_URL` | ✅ local | — |
| OpenAI | `OPENAI_API_KEY` | ❌ | <https://platform.openai.com/api-keys> |
| Anthropic | `ANTHROPIC_API_KEY` | ❌ | <https://console.anthropic.com/settings/keys> |
| DeepSeek | `DEEPSEEK_API_KEY` | ❌ | <https://platform.deepseek.com/api_keys> |
| xAI | `XAI_API_KEY` | ❌ | <https://console.x.ai/> |
| Anything else | `CUSTOM_BASE_URL` + `CUSTOM_MODELS` | — | see below |

To use several keys for one provider, append an `_API_KEYS` variable:

```env
GROQ_API_KEYS=gsk_first,gsk_second,gsk_third
```

## Picking a model

The `model` field accepts three forms:

| You send | What happens |
| --- | --- |
| `free`, `fast`, `smart`, `code`, `vision`, `reasoning`, `long`, `all` | Resolves to an ordered candidate list, tries them in turn |
| `groq/openai/gpt-oss-120b` | Provider prefix, model passed straight through |
| `google/gemma-4-31b-it:free` | Plain model id, matched across configured providers |

`GET /v1/models` lists every alias and every concrete model:

```bash
curl -s http://localhost:8787/v1/models | jq '.data[].id'
```

Aliases are defined in [`src/providers/catalog.js`](src/providers/catalog.js) and
can be fully replaced in `router.config.json`:

```json
{
  "aliases": {
    "cheap": [
      "groq/openai/gpt-oss-20b",
      "groq/qwen/qwen3.8-27b",
      "cerebras/llama3.1-8b"
    ]
  }
}
```

## Using it from your app

### Python (official SDK)

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8787/v1", api_key="unused")

stream = client.chat.completions.create(
    model="free",
    messages=[{"role": "user", "content": "Write a haiku about fallbacks."}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

If you set `ROUTER_API_KEY`, pass that as `api_key`.

### JavaScript / TypeScript

```js
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://localhost:8787/v1', apiKey: 'unused' });
const reply = await client.chat.completions.create({
  model: 'smart',
  messages: [{ role: 'user', content: 'Explain cool-downs in one sentence.' }]
});
console.log(reply.choices[0].message.content);
```

### Tools that only take a base URL

- **Cursor / Continue / Cline:** provider “OpenAI compatible”, base URL
  `http://localhost:8787/v1`, model `free` (or any alias).
- **LibreChat / Open WebUI:** custom OpenAI endpoint, same URL.
- **`OPENAI_BASE_URL`:** export `OPENAI_BASE_URL=http://localhost:8787/v1` and
  most CLI tools pick it up.

## How fallback works

```
request ──▶ candidates for the model ──▶ 1. groq/openai/gpt-oss-20b
                                          │  429 too many requests
                                          │  → key cooled down 20s (from Retry-After)
                                          ▼
                                       2. google/gemini-3.8-flash
                                          │  200 ✔
                                          ▼
                                        stream / JSON back to the client
```

1. The requested model becomes an ordered candidate list; unconfigured providers
   are dropped, duplicates removed, and the list is capped at `MAX_ATTEMPTS`.
2. Each attempt uses the least-recently-used healthy key of that provider.
3. The response status decides what happens next:

   | Status | Effect |
   | --- | --- |
   | `429` | key cools down (`Retry-After` or 60 s, escalating), try next provider |
   | `401` / `403` | key cools down 10 min — probably invalid, try next |
   | `402` | key cools down 1 h — out of credits |
   | `5xx`, timeouts, DNS | 15 s cool-down, try next |
   | `400` / `404` / `422` | request-specific: next provider, **key unharmed** |
   | `200` with an `error` envelope | treated as a failure (OpenRouter does this) |

4. For streams, fallback only happens *before* the first byte reaches the
   client. Once the stream started, a mid-stream failure ends the stream.

Response headers show the decision: `x-router-provider`, `x-router-model`,
`x-router-attempts`, `x-router-latency-ms`.

## Dashboard

`http://localhost:8787/` shows:

- provider readiness, a bar per key (green ready, amber cooling),
- requests / errors / average latency per provider,
- success rate, fallback count and token totals,
- every alias with how many of its candidates are actually available,
- a streaming playground, and a reset button for cool-downs and counters.

If `ROUTER_API_KEY` is set, the dashboard asks for it once (stored in
`localStorage`, sent as a bearer token).

## Configuration

### Environment (`.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` to keep it local-only) |
| `PORT` | `8787` | Listen port |
| `ROUTER_API_KEY` | *(empty)* | Bearer token required for `/v1/*` and `/api/*` |
| `DEFAULT_ALIAS` | `free` | Alias used when `model` is missing, empty or `auto` |
| `MAX_ATTEMPTS` | `6` | Maximum providers tried per request |
| `CONNECT_TIMEOUT_MS` | `20000` | Time allowed until upstream headers arrive |
| `REQUEST_TIMEOUT_MS` | `180000` | Total time for a non-streaming request |
| `MAX_BODY_BYTES` | `10485760` | Request body limit |
| `CORS_ORIGIN` | `*` | `Access-Control-Allow-Origin` |
| `LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info`, `debug` |
| `COOLDOWN_RATE_LIMIT_MS` | `60000` | Base cool-down for a 429 |
| `COOLDOWN_AUTH_MS` | `600000` | Cool-down for 401/403 |
| `COOLDOWN_SERVER_MS` | `15000` | Cool-down for 5xx |
| `COOLDOWN_NETWORK_MS` | `10000` | Cool-down for timeouts/network errors |
| `COOLDOWN_PAYMENT_MS` | `3600000` | Cool-down for 402 |
| `CONFIG_PATH` | `router.config.json` | Override file location |
| `DISABLE_DASHBOARD` | — | `1` removes the HTML page (JSON API stays) |

Secrets stay in `router.config.json` too if you prefer — that file is git-ignored.

### `router.config.json`

Optional. Copy [`router.config.example.json`](router.config.example.json) to
`router.config.json`.

```jsonc
{
  "defaultAlias": "free",
  "maxAttempts": 6,
  "aliases": {
    "cheap": ["groq/openai/gpt-oss-20b"]
  },
  "providers": {
    "groq": { "keys": ["gsk_…", "gsk_…"] },
    "openai": { "disabled": true }
  }
}
```

#### Any other OpenAI-compatible server

vLLM, LocalAI, llama.cpp’s server, an internal proxy — all of them work.
Either via env:

```env
CUSTOM_BASE_URL=http://localhost:8000/v1
CUSTOM_API_KEY=optional
CUSTOM_MODELS=Qwen/Qwen2.5-7B-Instruct,my-finetune
```

or as a named provider in `router.config.json`:

```json
{
  "providers": {
    "vllm": {
      "label": "Local vLLM",
      "baseUrl": "http://localhost:8000/v1",
      "style": "openai",
      "requiresKey": false,
      "models": [{ "id": "Qwen/Qwen2.5-7B-Instruct", "tags": ["free", "fast"] }]
    }
  }
}
```

Provider ids that are not in the catalog are created on the fly, so you can
address them directly: `"model": "vllm/Qwen/Qwen2.5-7B-Instruct"`.

### Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI-compatible, `stream: true` supported |
| `GET` | `/v1/models` | Aliases + concrete models |
| `GET` | `/health` | `ok` / `degraded` |
| `GET` | `/api/status` | Providers, keys, aliases, counters |
| `GET` | `/api/stats` | Counters only |
| `POST` | `/api/reset` | Clears cool-downs and counters |
| `GET` | `/` | Dashboard |

Errors use the OpenAI envelope:

```json
{ "error": { "message": "Every key for Groq is rate limited — retry in 41s", "type": "upstream_error", "code": "all_providers_failed", "hint": "Tried 2 candidate(s) — …" } }
```

## Adding a provider

A provider is one entry in [`src/providers/catalog.js`](src/providers/catalog.js):

```js
{
  id: 'myprovider',
  label: 'My Provider',
  docs: 'https://example.com/keys',
  style: 'openai',                        // or 'anthropic'
  baseUrl: 'https://api.example.com/v1',
  env: ['MYPROVIDER_API_KEYS', 'MYPROVIDER_API_KEY'],
  free: true,
  models: [
    { id: 'my-model', tags: ['free', 'fast'] },
    { id: 'my-model-pro', tags: ['smart', 'code'] }
  ]
}
```

Tag a model `free` and it automatically joins the `free` alias. Anything with a
different request/response shape than OpenAI or Anthropic needs a small adapter
in `src/providers/` — around 40 lines, using Anthropic’s translator as a model.

## Development

```bash
npm test        # node:test suite, no dependencies
npm run dev     # restart on change
node src/index.js --help
```

```
src/
├── index.js            HTTP server, routes, streaming, CLI
├── config.js           env + router.config.json → runtime config
├── router.js           candidate resolution, fallback loop, cool-down policy
├── keys.js             key pools, masking, Retry-After parsing
├── model.js            alias / provider-prefix parsing
├── http.js             JSON helpers, body limits, signal combining
├── sse.js              forgiving SSE parser
├── stats.js            counters for the dashboard
├── providers/
│   ├── catalog.js      provider + model definitions, default aliases
│   ├── openai.js       OpenAI-compatible dialect
│   └── anthropic.js    Messages API ↔ chat.completions, incl. streams
├── env.js              tiny .env loader
└── logger.js
public/index.html       dashboard (vanilla JS, no build step)
test/                   unit + end-to-end tests with fake providers
```

Tests spin up fake upstream servers on random ports, so they never touch a real
API and never need a key.

## Limits worth knowing

- **Cool-downs and counters live in memory.** A restart forgets them. That is
  deliberate: it keeps the router a single stateless process with no database.
- **Free tiers change.** Model ids are defaults and providers retire them.
  If one 404s, the router falls through, but you should update the catalog or
  override the models in `router.config.json`.
- **No retry of the same provider after a mid-stream failure** — the bytes were
  already sent, so re-sending would duplicate the answer.
- **`/v1/chat/completions` only.** Embeddings, image and audio endpoints are not
  routed yet.
- Only `POST /v1/chat/completions` with a JSON body and `messages` is examined;
  everything else is forwarded as-is to the chosen provider.

## Legal & fair use

The router is a client. It does not create or bypass quotas — it only avoids
wasting them. Every request is subject to the terms of service of whichever
provider answers it. Use your own keys, respect rate limits, and do not use this
to evade billing or access controls.

Free tiers are offered by the providers and can change or disappear at any time.

## License

[MIT](LICENSE) © 2026 djsTimhac

Contributions are welcome — open an issue or a pull request.
