/**
 * Minimal LM Studio client (OpenAI-compatible API). SPEC.md §3.2, §6.1.
 * Uses the global fetch (Node 18+). All calls fail soft with a timeout so the
 * mission engine keeps working when the LLM is unavailable.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LmStudioOptions {
  endpoint?: string; // default http://127.0.0.1:1234
  model?: string; // default: first non-embedding model reported
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

const DEFAULT_ENDPOINT = 'http://127.0.0.1:1234';

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

export class LmStudioClient {
  readonly endpoint: string;
  private model: string | undefined;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(opts: LmStudioOptions = {}) {
    this.endpoint = (opts.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, '');
    this.model = opts.model;
    this.temperature = opts.temperature ?? 0.3;
    // Reasoning models need budget for hidden thinking BEFORE the answer.
    this.maxTokens = opts.maxTokens ?? 2048;
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  /** Returns the list of model ids, or [] if LM Studio is unreachable. */
  async listModels(): Promise<string[]> {
    try {
      return await withTimeout(4000, async (signal) => {
        const res = await fetch(`${this.endpoint}/v1/models`, { signal });
        if (!res.ok) return [];
        const body = (await res.json()) as { data?: Array<{ id: string }> };
        return (body.data ?? []).map((m) => m.id);
      });
    } catch {
      return [];
    }
  }

  /** True if LM Studio answers /v1/models. */
  async isAvailable(): Promise<boolean> {
    return (await this.listModels()).length > 0;
  }

  /** Pick a chat model (skip embedding models) unless one was configured. */
  async resolveModel(): Promise<string | null> {
    if (this.model) return this.model;
    const ids = await this.listModels();
    const chat = ids.find((id) => !/embed/i.test(id)) ?? ids[0];
    if (chat) this.model = chat;
    return chat ?? null;
  }

  /**
   * Non-streaming chat completion. Returns the assistant text, or null on any
   * failure (unreachable, no model, timeout, bad JSON) — callers degrade to
   * rule-based guidance.
   */
  async chat(messages: ChatMessage[]): Promise<string | null> {
    const model = await this.resolveModel();
    if (!model) return null;
    // One retry: small local models occasionally return empty content.
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await this.chatOnce(model, messages);
      if (text) return text;
    }
    return null;
  }

  private async chatOnce(model: string, messages: ChatMessage[]): Promise<string | null> {
    try {
      return await withTimeout(this.timeoutMs, async (signal) => {
        const res = await fetch(`${this.endpoint}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
          body: JSON.stringify({
            model,
            messages,
            temperature: this.temperature,
            max_tokens: this.maxTokens,
            stream: false,
          }),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const text = body.choices?.[0]?.message?.content?.trim();
        return text ? stripThink(text) : null;
      });
    } catch {
      return null;
    }
  }
}

/** Some local reasoning models emit <think>...</think>; drop it for speech. */
function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}
