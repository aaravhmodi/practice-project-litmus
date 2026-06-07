-- Run this once in the Supabase SQL editor for your project.
-- It creates the table the SupabaseProvider writes snapshots to,
-- and enables Realtime on it for presence / broadcast.

create table if not exists public.document_snapshots (
  room_id    text primary key,
  snapshot   jsonb not null,
  updated_at timestamptz not null default now()
);

-- Allow authenticated and anonymous users to read and upsert snapshots.
-- Tighten these policies once you add real auth.
alter table public.document_snapshots enable row level security;

create policy "anyone can read snapshots"
  on public.document_snapshots for select
  using (true);

create policy "anyone can upsert snapshots"
  on public.document_snapshots for insert
  with check (true);

create policy "anyone can update snapshots"
  on public.document_snapshots for update
  using (true);
