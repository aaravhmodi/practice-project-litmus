export interface ModelChunk {
  text: string
  done: boolean
}

const FAST_OUTPUT =
  "Based on the prompt, here is a concise response. " +
  "The key insight is that clarity matters most. " +
  "Processing complete."

const SLOW_OUTPUT =
  "Carefully analyzing the prompt and input provided... " +
  "First, considering the broader context and implications. " +
  "Second, weighing all relevant factors systematically. " +
  "Third, synthesizing a thorough and accurate response. " +
  "Analysis complete."

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export async function* streamModel(
  _prompt: string,
  _input: string,
  behavior: { slow?: boolean; errAfterMs?: number } = {}
): AsyncIterable<ModelChunk> {
  const text = behavior.slow ? SLOW_OUTPUT : FAST_OUTPUT
  // Fast: 100ms × ~30 chunks ≈ 3s  |  Slow: 300ms × ~40 chunks ≈ 12s
  const chunkMs = behavior.slow ? 300 : 100
  const words = text.split(" ")
  const start = Date.now()

  for (let i = 0; i < words.length; i++) {
    if (behavior.errAfterMs && Date.now() - start > behavior.errAfterMs) {
      throw new Error("mid-stream error")
    }
    await sleep(chunkMs)
    yield { text: (i === 0 ? "" : " ") + words[i], done: false }
  }

  yield { text: "", done: true }
}
