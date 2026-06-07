-- Run this once in the Supabase SQL editor for your project.

-- ── Snapshot table (kept as legacy fallback) ──────────────────────────────────
create table if not exists public.document_snapshots (
  room_id    text primary key,
  snapshot   jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.document_snapshots enable row level security;

drop policy if exists "anyone can read snapshots" on public.document_snapshots;
create policy "anyone can read snapshots"
  on public.document_snapshots for select using (true);

drop policy if exists "anyone can upsert snapshots" on public.document_snapshots;
create policy "anyone can upsert snapshots"
  on public.document_snapshots for insert with check (true);

drop policy if exists "anyone can update snapshots" on public.document_snapshots;
create policy "anyone can update snapshots"
  on public.document_snapshots for update using (true);

-- ── Incremental Y.js update log ───────────────────────────────────────────────
-- One row per Y.js update event. Append-only — never updated or deleted.
-- y_update is stored as a jsonb number-array so the JS client can round-trip it
-- with Array.from(Uint8Array) / Uint8Array.from(row.y_update).
-- client_id lets receivers skip their own inserts without an extra round-trip.
create table if not exists public.doc_updates (
  id          bigint generated always as identity primary key,
  doc_id      text        not null,
  client_id   text        not null,
  y_update    jsonb       not null,
  created_at  timestamptz not null default now()
);

create index if not exists doc_updates_doc_id_id_idx
  on public.doc_updates (doc_id, id);

alter table public.doc_updates enable row level security;

drop policy if exists "anyone can read doc_updates" on public.doc_updates;
create policy "anyone can read doc_updates"
  on public.doc_updates for select using (true);

drop policy if exists "anyone can insert doc_updates" on public.doc_updates;
create policy "anyone can insert doc_updates"
  on public.doc_updates for insert with check (true);

-- ── Broadcast trigger ─────────────────────────────────────────────────────────
-- After every insert, fires a Realtime Broadcast on topic "doc:<doc_id>:updates".
-- The payload is lightweight (just the new row's id + client_id) so receivers
-- fetch the actual binary data from the table instead of decoding it from the event.
create or replace function public.notify_doc_update()
returns trigger language plpgsql security definer as $$
begin
  perform realtime.send(
    jsonb_build_object(
      'id',        NEW.id,
      'doc_id',    NEW.doc_id,
      'client_id', NEW.client_id
    ),
    'y_update_added',
    'doc:' || NEW.doc_id || ':updates',
    false   -- false = public channel (no auth required)
  );
  return NEW;
end;
$$;

drop trigger if exists doc_update_broadcast_trigger on public.doc_updates;
create trigger doc_update_broadcast_trigger
  after insert on public.doc_updates
  for each row execute function public.notify_doc_update();
