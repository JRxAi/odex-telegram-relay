-- Minimal Supabase schema for Codex Telegram Relay memory.
-- Run in Supabase SQL editor before enabling SUPABASE_* env vars.

create extension if not exists vector;

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  channel text not null default 'telegram',
  metadata jsonb not null default '{}',
  embedding vector(1536)
);

create index if not exists idx_messages_created_at on messages(created_at desc);
create index if not exists idx_messages_channel on messages(channel);

create table if not exists memory (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  type text not null check (type in ('fact', 'goal', 'completed_goal', 'preference')),
  content text not null,
  deadline timestamptz,
  completed_at timestamptz,
  priority int not null default 0,
  metadata jsonb not null default '{}',
  embedding vector(1536)
);

create index if not exists idx_memory_type on memory(type);
create index if not exists idx_memory_updated_at on memory(updated_at desc);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_memory_updated_at on memory;
create trigger trg_memory_updated_at
before update on memory
for each row
execute function set_updated_at();
