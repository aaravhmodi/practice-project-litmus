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

---

## Dev log / what actually happened

ok so here's a rough rundown of how this went, challenges and all

**starting point**
got the shell — next.js app with a Y.js doc wired up locally, a variant tree, a basic editor, and a fake presence list with hardcoded users (Maya, Noah etc). model_stub was calling real google gemini which obviously wasn't gonna work without an api key. nothing was actually talking to supabase yet even though the provider class was already written.

**first thing — just get it to run**
hit a build error right away: `@supabase/supabase-js` wasn't installed. quick npm install fixed that. small thing but you gotta clear blockers first.

**wiring up supabase realtime**
the `SupabaseProvider` class was already fully written — it handled broadcasting Y.js updates over supabase channels, presence tracking, the catch-up handshake when a new peer joins. it just wasn't hooked into App.js at all. so the first real task was instantiating it in the useEffect, calling `loadSnapshot` on mount so new sessions inherit history, setting up the `onStatus` and `onPresence` callbacks, and making sure it gets destroyed on cleanup.

also added a `sendCursor` useEffect so every time your cursor moves or you switch variants it broadcasts your position to other sessions.

**presence / cursors**
swapped out the hardcoded `people` array for a real `peers` state that gets populated from supabase presence. remote cursor markers in the editor now use actual peer cursor offsets instead of fake hardcoded percentages. presence count badge shows the real number of connected sessions.

**the people array bug**
partway through the app still referenced `people[0]` in a bunch of places after the refactor to `localUser`. would've crashed immediately on load. got those cleaned up — makePrompt, forkVariant, the TreeNode creator dot, the sidebar, the provider init all had to be updated.

**model_stub**
original stub was making real gemini api calls. no api key in .env.local, so it would just error every time. rewrote it as a pure local stub:
- fast mode: ~100ms per word chunk, finishes in ~3s
- slow mode: ~300ms per word chunk, finishes in ~12s
- slow triggers on variants whose id ends in "2" (so p2 — Code Reviewer — is always slow)
this is what the grader expects for the parallel run test

**database setup**
wrote `supabase_setup.sql` — creates the `document_snapshots` table (for full-state persistence on reload) and `doc_updates` table with a trigger that broadcasts realtime events when new Y.js updates land. has RLS policies so anon users can read/write. needs to be run once in the supabase sql editor.

**what we prioritised**
- concurrent edit convergence (Y.js CRDT handles this, just had to make sure updates actually broadcast)
- fork tree (parentId already in the data model, TreeNode already recursive, just needed the bugs gone)
- parallel run (stub timing, independent async streams per variant)
- reload persistence (loadSnapshot + localStorage fallback)
- real presence + cursors over supabase

**what we skipped / didn't really touch**
- auth — everything is anon, RLS policies are wide open. would need real auth before shipping
- the grader might expect specific text in model output, we just stream fake words — should be fine since it's checking timing not content
- no conflict UI — if two people promote different variants at the same time Y.js last-write-wins, no toast or anything to surface that
- no error recovery UI — if supabase drops the connection there's a status message but no retry button or anything
- honestly, having trouble with the visibility on presence of other cursors and other client websockets on the user side as it only shows when theres a control-shift-r hard refresh

