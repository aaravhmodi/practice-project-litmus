# Workshop

*A real-time collaborative editor for prompts.*

## Overview

Inside every AI startup, prompt engineering happens in shared Google Docs, Notion pages, and ad-hoc Slack threads. None of those tools were designed for the workflow, iterating on a prompt with a teammate, forking a variant to test a hypothesis, running both against the same input, deciding which one wins. There's an emerging category of products trying to solve this (think 'Figma for prompts'), but most teams still live in Docs.

You're going to build the core of one. A real-time collaborative editor for prompts where two people can edit the same prompt simultaneously, fork it into variants, run all variants against the same test input, and watch outputs stream in side by side. Pick a real-time strategy. Make it not flicker.

## Problem Statement

Build a web app that lets multiple users collaboratively edit prompts in real time, fork variants from a base prompt, run all variants against a shared test input, view streaming model outputs side by side, and promote a winning variant. State syncs in real time. Conflicts resolve cleanly.

## Getting Started

### Prerequisites
- Node.js 20+
- Any modern framework you're comfortable with (Next.js, Vite + React, SvelteKit, etc.). Starter is Next.js.

### Setup
Dependencies are installed automatically when you initialize the assessment with the Litmus CLI. You're ready to start coding.

What's in the workspace:
- `data/seed_prompts.json`, 4 example prompts to bootstrap the workspace with content.
- `data/test_inputs.json`, 5 example inputs the candidate can run variants against during dev.
- `types.ts`, shared types (`Prompt`, `Variant`, `User`, etc.).
- `model_stub.ts`, stubbed streaming LLM client (`streamModel(prompt, input)` returns an async iterable of tokens with realistic per-token latency). Replaced at grade time by a real client.

## Requirements

1. Render a workspace UI where multiple users can edit the same prompt simultaneously. When two users have the editor open and both type, both see each other's edits in real time without losing characters or jumping cursors. Multiple users on the same prompt must converge to the same final state.
2. Each prompt supports forking. From any prompt, a user can create a variant, a separate editable copy that knows its parent. The variant tree (parent → children → grandchildren) is visible.
3. From a prompt and its variants, the user can pick a test input and run all variants against it. Each variant streams its output independently. The four outputs appear side by side; a slow variant must not block the others.
4. A user can promote a variant to "main" for the prompt. Promotion is a single atomic action visible to all connected users.
5. Presence is visible. When other users are editing the same prompt, you can tell who they are and where their cursor is.
6. State persists. If the page reloads, the workspace state (prompts, variants, parent links, current main) is restored.

## Examples

**Example 1: Two-user concurrent edit**
```
User A and User B both open prompt P.
User A types "Be concise." at the start.
User B types "Use bullets." at the end.
Both users' editors end with: "Be concise. ... Use bullets."
No characters lost, no duplication.
```

**Example 2: Fork + parallel run**
```
Prompt P has 3 variants: P, P.v1, P.v2.
User picks test input I1 and clicks "Run all".
Three model_stub streams start in parallel.
P.v1 finishes in 4s; P.v2 takes 12s.
P.v1's output is fully visible while P.v2 is still streaming.
```

**Example 3: Promote**
```
Workspace shows main pointing at P (the root).
User clicks "Promote" on P.v1.
main now points at P.v1 for all connected users; the promote event is visible in real time.
```

## Submission Guidelines

### What to Submit
- All source code (frontend, any backend or sync server you wrote, server-side endpoints).

### How to Submit
```bash
litmus submit
```
