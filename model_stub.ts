import { GoogleGenerativeAI } from "@google/generative-ai"

export interface ModelChunk {
  text: string
  done: boolean
}

// ── Timed stub (used when Gemini key is absent or quota is exceeded) ──────────
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

async function* stubStream(
  behavior: { slow?: boolean; errAfterMs?: number }
): AsyncIterable<ModelChunk> {
  const words = (behavior.slow ? SLOW_OUTPUT : FAST_OUTPUT).split(" ")
  // Fast: 100ms × ~30 chunks ≈ 3s  |  Slow: 300ms × ~40 chunks ≈ 12s
  const chunkMs = behavior.slow ? 300 : 100
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

// ── Real Gemini stream ────────────────────────────────────────────────────────
const API_KEY =
  typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_GEMINI_API_KEY ?? ""
    : ""

export async function* streamModel(
  prompt: string,
  input: string,
  behavior: { slow?: boolean; errAfterMs?: number } = {}
): AsyncIterable<ModelChunk> {
  if (!API_KEY) {
    yield* stubStream(behavior)
    return
  }

  const genAI = new GoogleGenerativeAI(API_KEY)
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" })
  const start = Date.now()

  try {
    const result = await model.generateContentStream(
      `${prompt}\n\nInput: ${input}`
    )

    for await (const chunk of result.stream) {
      if (behavior.errAfterMs && Date.now() - start > behavior.errAfterMs) {
        throw new Error("mid-stream error")
      }
      const text = chunk.text()
      if (text) yield { text, done: false }
    }

    yield { text: "", done: true }
  } catch (err: any) {
    // Quota exhausted or network error — fall back to stub so the UI still works
    if (err?.status === 429 || err?.message?.includes("quota")) {
      console.warn("[model_stub] Gemini quota exceeded, falling back to stub")
      yield* stubStream(behavior)
    } else {
      throw err
    }
  }
}
