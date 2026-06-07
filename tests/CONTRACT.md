# Contract checklist

The grader will exercise the following behaviors via a headless browser harness.
These are the things to make work. Order matters: the harder ones depend on
the earlier ones being solid.

## Concurrent edit convergence
- Two browser sessions on the same prompt.
- Each session applies ~20 character-level edits over ~1 second.
- After both stop, both sessions show the same final body. No characters lost.

## Fork tree
- Create a variant from prompt P.
- The variant's parent_id references P.
- The UI shows the parent / child relationship.

## Parallel run
- Run all variants of a prompt against the same test input.
- model_stub for one variant is slow (12s); others fast (3s).
- Fast variants finish and render their output while the slow one is still streaming.

## Presence + cursors
- Two sessions on the same prompt show each other's presence and cursor positions.

## Promote
- Click "Promote" on a variant.
- The change is visible to the other connected session in real time.
- The change persists across page reload.

## Reload
- Edit, fork, promote, reload the page.
- Workspace state (prompts, variants, parent links, current main) is restored.
