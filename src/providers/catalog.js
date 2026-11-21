/**
 * Built-in provider catalog.
 *
 * Every entry describes an HTTP API that speaks either the OpenAI
 * `/chat/completions` dialect (`style: "openai"`) or the Anthropic
 * `/messages` dialect (`style: "anthropic"`).
 *
 * Model ids drift. Providers rename, retire and re-price models constantly, so
 * treat these lists as "known good at the time of writing" and not as a
 * contract. Override them in `router.config.json`, set `*_MODELS` for the local
 * runtimes, or simply call the router with `"model": "<provider>/<exact-id>"` to
 * pass an id straight through — no catalog entry needed.
 *
 * Verified in November 2026 against:
 *   · Groq        GET /openai/v1/models
 *   · OpenRouter  GET /api/v1/models  (filtered to `:free`)
 *   · Google      ai.google.dev/gemini-api/docs/models
 *
 * `free: true` marks a provider with a usable free tier (or a local runtime).
 * Only models tagged `free` join the generated `free` alias — a provider can be
 * free-tier and still serve paid models, so the tag is explicit on purpose.
 */

/**
 * @typedef {Object} ModelDef
 * @property {string} id        Model id exactly as the provider expects it.
 * @property {string[]} [tags]  free | fast | smart | code | long | vision | reasoning
 */

/**
 * @typedef {Object} ProviderDef
 * @property {string} id
 * @property {string} label
 * @property {string} docs
 * @property {'openai'|'anthropic'} style
 * @property {string} baseUrl
 * @property {string[]} env          Env vars that may hold keys (first wins).
 * @property {boolean} free
 * @property {boolean} [requiresKey]
 * @property {boolean} [defaultEnabled] Local runtimes are off until their URL is set.
 * @property {string} [baseUrlEnv]   Env var that overrides the base URL.
 * @property {string} [apiKeyEnv]    Env var that holds a single key.
 * @property {string} [modelsEnv]    Env var with a comma-separated model id list.
 * @property {string} [labelEnv]     Env var that overrides the display label.
 * @property {Record<string,string>} [headers]
 * @property {ModelDef[]} models
 */

/** @type {ProviderDef[]} */
export const PROVIDER_CATALOG = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    docs: 'https://openrouter.ai/keys',
    style: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    env: ['OPENROUTER_API_KEYS', 'OPENROUTER_API_KEY'],
    free: true,
    headers: { 'X-Title': 'FreeUnlimitedAIRouter' },
    models: [
      { id: 'nvidia/nemotron-3.5-lightning:free', tags: ['free', 'fast', 'long'] },
      { id: 'inclusionai/ling-3.2-flash:free', tags: ['free', 'fast', 'long'] },
      { id: 'google/gemma-4-31b-it:free', tags: ['free', 'general', 'code'] },
      { id: 'google/gemma-4-26b-a4b-it:free', tags: ['free', 'fast', 'general'] },
      { id: 'nvidia/nemotron-3.5-super-vl:free', tags: ['free', 'vision', 'long'] },
      { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', tags: ['free', 'reasoning'] },
      { id: 'baidu/ernie-5.5-flash-preview:free', tags: ['free', 'long'] }
    ]
  },
  {
    id: 'groq',
    label: 'Groq',
    docs: 'https://console.groq.com/keys',
    style: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    env: ['GROQ_API_KEYS', 'GROQ_API_KEY'],
    free: true,
    models: [
      { id: 'openai/gpt-oss-20b', tags: ['free', 'fast', 'general'] },
      { id: 'openai/gpt-oss-120b', tags: ['free', 'fast', 'smart', 'code'] },
      { id: 'qwen/qwen3.8-27b', tags: ['free', 'general', 'code'] }
    ]
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    docs: 'https://cloud.cerebras.ai/',
    style: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    env: ['CEREBRAS_API_KEYS', 'CEREBRAS_API_KEY'],
    free: true,
    models: [
      { id: 'llama3.1-8b', tags: ['free', 'fast'] },
      { id: 'llama3.3-70b', tags: ['free', 'fast', 'general'] }
    ]
  },
  {
    id: 'google',
    label: 'Google Gemini',
    docs: 'https://aistudio.google.com/apikey',
    style: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    env: ['GEMINI_API_KEYS', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    free: true,
    models: [
      { id: 'gemini-4-hydrogen', tags: ['free', 'smart', 'long', 'vision'] },
      { id: 'gemini-3.8-flash', tags: ['free', 'fast', 'vision', 'code'] },
      { id: 'gemini-4-carbon', tags: ['smart', 'long', 'vision'] }
    ]
  },
  {
    id: 'github',
    label: 'GitHub Models',
    docs: 'https://github.com/settings/tokens',
    style: 'openai',
    baseUrl: 'https://models.github.ai/inference',
    env: ['GITHUB_MODELS_TOKEN', 'GITHUB_TOKEN'],
    free: true,
    models: [
      { id: 'openai/gpt-4o-mini', tags: ['free', 'fast'] },
      { id: 'openai/gpt-4o', tags: ['free', 'smart'] },
      { id: 'meta/Llama-3.3-70B-Instruct', tags: ['free', 'general'] }
    ]
  },
  {
    id: 'mistral',
    label: 'Mistral',
    docs: 'https://console.mistral.ai/api-keys',
    style: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    env: ['MISTRAL_API_KEYS', 'MISTRAL_API_KEY'],
    free: true,
    models: [
      { id: 'mistral-small-latest', tags: ['free', 'general'] },
      { id: 'codestral-latest', tags: ['code'] },
      { id: 'mistral-large-latest', tags: ['smart'] }
    ]
  },
  {
    id: 'together',
    label: 'Together AI',
    docs: 'https://api.together.xyz/settings/api-keys',
    style: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    env: ['TOGETHER_API_KEYS', 'TOGETHER_API_KEY'],
    free: true,
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free', tags: ['free', 'general'] },
      { id: 'meta-llama/Llama-Vision-Free', tags: ['free', 'vision'] },
      { id: 'Qwen/Qwen2.5-72B-Instruct-Turbo', tags: ['general'] }
    ]
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    docs: 'https://ollama.com',
    style: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    env: [],
    baseUrlEnv: 'OLLAMA_BASE_URL',
    modelsEnv: 'OLLAMA_MODELS',
    free: true,
    requiresKey: false,
    defaultEnabled: false,
    models: [{ id: 'llama3.2', tags: ['free', 'general'] }]
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    docs: 'https://lmstudio.ai',
    style: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    env: [],
    baseUrlEnv: 'LMSTUDIO_BASE_URL',
    modelsEnv: 'LMSTUDIO_MODELS',
    free: true,
    requiresKey: false,
    defaultEnabled: false,
    models: [{ id: 'local-model', tags: ['free'] }]
  },
  {
    id: 'openai',
    label: 'OpenAI',
    docs: 'https://platform.openai.com/api-keys',
    style: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    env: ['OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    free: false,
    models: [
      { id: 'gpt-4o-mini', tags: ['fast', 'vision'] },
      { id: 'gpt-4o', tags: ['smart', 'vision'] },
      { id: 'gpt-4.1-mini', tags: ['fast', 'code'] }
    ]
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    docs: 'https://console.anthropic.com/settings/keys',
    style: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    env: ['ANTHROPIC_API_KEYS', 'ANTHROPIC_API_KEY'],
    free: false,
    models: [
      { id: 'claude-3-5-haiku-latest', tags: ['fast'] },
      { id: 'claude-sonnet-4-20250514', tags: ['smart', 'code', 'vision'] }
    ]
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    docs: 'https://platform.deepseek.com/api_keys',
    style: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    env: ['DEEPSEEK_API_KEYS', 'DEEPSEEK_API_KEY'],
    free: false,
    models: [
      { id: 'deepseek-chat', tags: ['smart', 'code'] },
      { id: 'deepseek-reasoner', tags: ['reasoning', 'smart'] }
    ]
  },
  {
    id: 'xai',
    label: 'xAI',
    docs: 'https://console.x.ai/',
    style: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    env: ['XAI_API_KEYS', 'XAI_API_KEY'],
    free: false,
    models: [
      { id: 'grok-3-mini', tags: ['fast'] },
      { id: 'grok-3', tags: ['smart'] }
    ]
  },
  {
    id: 'custom',
    label: 'Custom OpenAI-compatible',
    docs: 'https://github.com/djsTimhac/FreeUnlimitedAIRouter#any-other-openai-compatible-server',
    style: 'openai',
    baseUrl: '',
    env: [],
    baseUrlEnv: 'CUSTOM_BASE_URL',
    apiKeyEnv: 'CUSTOM_API_KEY',
    modelsEnv: 'CUSTOM_MODELS',
    labelEnv: 'CUSTOM_LABEL',
    free: true,
    requiresKey: false,
    models: []
  }
];

/**
 * Alias ordering is deliberate: the first candidate that is actually
 * configured gets tried first, the rest are fallbacks. Free options come before
 * paid ones because that is the point of the project.
 *
 * `free` and `all` are generated from the catalog tags at runtime.
 */
export const DEFAULT_ALIASES = {
  fast: [
    'groq/openai/gpt-oss-20b',
    'cerebras/llama3.1-8b',
    'google/gemini-3.8-flash',
    'groq/qwen/qwen3.8-27b',
    'openai/gpt-4o-mini',
    'github/openai/gpt-4o-mini',
    'openrouter/nvidia/nemotron-3.5-lightning:free'
  ],
  smart: [
    'google/gemini-4-hydrogen',
    'anthropic/claude-sonnet-4-20250514',
    'openai/gpt-4o',
    'google/gemini-4-carbon',
    'deepseek/deepseek-chat',
    'xai/grok-3',
    'github/openai/gpt-4o',
    'openrouter/google/gemma-4-31b-it:free'
  ],
  code: [
    'mistral/codestral-latest',
    'deepseek/deepseek-chat',
    'anthropic/claude-sonnet-4-20250514',
    'groq/openai/gpt-oss-120b',
    'openai/gpt-4.1-mini',
    'google/gemini-3.8-flash',
    'openrouter/google/gemma-4-31b-it:free'
  ],
  reasoning: [
    'deepseek/deepseek-reasoner',
    'openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'google/gemini-4-hydrogen',
    'anthropic/claude-sonnet-4-20250514'
  ],
  vision: [
    'google/gemini-3.8-flash',
    'openai/gpt-4o-mini',
    'anthropic/claude-sonnet-4-20250514',
    'openrouter/nvidia/nemotron-3.5-super-vl:free'
  ],
  long: [
    'google/gemini-4-hydrogen',
    'anthropic/claude-sonnet-4-20250514',
    'openai/gpt-4o',
    'openrouter/inclusionai/ling-3.2-flash:free'
  ]
};

/** @param {ProviderDef} provider */
export function modelIdsOf(provider) {
  return provider.models.map((m) => m.id);
}
