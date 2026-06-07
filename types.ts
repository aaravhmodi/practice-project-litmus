// types.ts, shared types for the prompt workshop.

export interface User {
  id: string
  name: string
  /** Hex color for presence display. */
  color: string
}

export interface Prompt {
  id: string
  /** Display title. */
  title: string
  /** Prompt body. The thing being edited. */
  body: string
  /** Parent variant id, or null for root. */
  parentId: string | null
  /** When this variant was created. */
  createdAt: string
  /** Who created it. */
  createdBy: string
}

export interface PromptTree {
  /** Root variant for this group. */
  root: Prompt
  /** All variants in the tree, flat. Each has a parentId pointing somewhere in this list. */
  variants: Prompt[]
  /** Id of the current "main" variant. */
  mainId: string
}

export interface RunResult {
  /** The variant this output came from. */
  variantId: string
  /** The test input it ran against. */
  inputId: string
  /** Concatenated streamed tokens so far. */
  output: string
  status: "streaming" | "complete" | "error"
  /** When the run started (ms since epoch). */
  startedAt: number
  /** Duration in ms (set once complete). */
  durationMs?: number
  error?: string
}

export interface TestInput {
  id: string
  label: string
  text: string
}

export interface CursorPosition {
  userId: string
  variantId: string
  /** Character offset in the body. */
  offset: number
}
