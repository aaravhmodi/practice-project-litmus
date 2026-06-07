// model_stub.ts, stubbed streaming model client.
//
// At grade time this is replaced by a real streaming LLM (Anthropic or OpenAI).
// Design defensively: the real client will have variable per-token latency,
// occasional stalls, and rare mid-stream errors.

export interface ModelChunk {
  /** Token text chunk. May span multiple actual tokens. */
  text: string
  /** True when this is the last chunk for this call. */
  done: boolean
}

export interface ModelError {
  error: string
}

const STUB_OUTPUTS: Record<string, string[]> = {
  default: [
    "Sure, here's a summary: ",
    "the key points are ",
    "(stub output) ",
    "this is a placeholder ",
    "for what a real LLM would say.",
  ],
}

/**
 * Stream a model's output for a (prompt, input) pair.
 *
 * Yields chunks with realistic per-chunk latency. The total stream takes
 * ~3-12 seconds depending on input length. Some calls will be slow (~12s);
 * others fast (~3s); your UI must handle this gracefully.
 *
 * If you need to swap models or simulate errors, use the optional `behavior`
 * parameter.
 */
export async function* streamModel(
  prompt: string,
  input: string,
  behavior: { slow?: boolean; errAfterMs?: number } = {}
): AsyncIterable<ModelChunk> {
  const chunks = STUB_OUTPUTS.default
  const baseDelay = behavior.slow ? 1800 : 500
  const start = Date.now()

  for (let i = 0; i < chunks.length; i++) {
    const jitter = Math.random() * 800
    await new Promise((r) => setTimeout(r, baseDelay + jitter))
    if (behavior.errAfterMs && Date.now() - start > behavior.errAfterMs) {
      throw new Error("(stub) mid-stream error")
    }
    yield { text: chunks[i], done: i === chunks.length - 1 }
  }
}
