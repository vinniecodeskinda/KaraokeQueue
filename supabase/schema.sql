-- =====================================================================
-- Home Karaoke — Supabase schema
-- Run this whole file once in Supabase → SQL Editor → New query.
-- Safe to re-run: it uses IF NOT EXISTS / OR REPLACE where possible.
-- =====================================================================

create extension if not exists pg_trgm;   -- fast ILIKE search on title/artist

-- ---------------------------------------------------------------------
-- songs: the catalog
-- ---------------------------------------------------------------------
create table if not exists public.songs (
  id               uuid primary key default gen_random_uuid(),
  title            text not null check (char_length(title) between 1 and 200),
  artist           text not null default '' check (char_length(artist) <= 200),
  youtube_video_id text not null unique check (youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'),
  tags             text[] not null default '{}',     -- e.g. {pop,english,90s}
  created_at       timestamptz not null default now()
);

create index if not exists songs_title_trgm  on public.songs using gin (title  gin_trgm_ops);
create index if not exists songs_artist_trgm on public.songs using gin (artist gin_trgm_ops);
create index if not exists songs_tags_gin    on public.songs using gin (tags);

-- ---------------------------------------------------------------------
-- queue: requests, in order. created_at is the ordering key.
-- ---------------------------------------------------------------------
create table if not exists public.queue (
  id          uuid primary key default gen_random_uuid(),
  song_id     uuid not null references public.songs(id) on delete cascade,
  guest_name  text not null check (char_length(btrim(guest_name)) between 1 and 40),
  status      text not null default 'queued'
              check (status in ('queued', 'playing', 'completed', 'skipped')),
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz
);

create index if not exists queue_active_idx on public.queue (status, created_at)
  where status in ('queued', 'playing');

-- At most ONE row can be 'playing' at a time. This makes double-advances
-- (two host tabs open, a double-fired ENDED event) fail safely instead of
-- corrupting the queue.
create unique index if not exists queue_single_playing
  on public.queue ((true)) where status = 'playing';

-- ---------------------------------------------------------------------
-- Guard rails to stay well inside free-tier limits and stop one phone
-- from flooding the queue.
-- ---------------------------------------------------------------------
create or replace function public.enforce_queue_limits()
returns trigger language plpgsql as $$
begin
  if (select count(*) from public.queue where status = 'queued') >= 200 then
    raise exception 'The queue is full (200 songs). Try again later.';
  end if;
  if (select count(*) from public.queue
       where status = 'queued' and lower(guest_name) = lower(btrim(new.guest_name))) >= 5 then
    raise exception 'You already have 5 songs waiting. Let someone else sing!';
  end if;
  new.guest_name := btrim(new.guest_name);
  new.status     := 'queued';     -- guests can never insert a 'playing' row
  new.created_at := now();        -- and can't jump the line with a fake timestamp
  return new;
end $$;

drop trigger if exists queue_limits on public.queue;
create trigger queue_limits before insert on public.queue
  for each row execute function public.enforce_queue_limits();

-- ---------------------------------------------------------------------
-- Row Level Security
-- Guests (anon key) may: read songs, read the queue, insert queue rows.
-- Nobody may update/delete directly; the host advances the queue via
-- the advance_queue() RPC below.
-- ---------------------------------------------------------------------
alter table public.songs enable row level security;
alter table public.queue enable row level security;

drop policy if exists "songs readable by everyone" on public.songs;
create policy "songs readable by everyone" on public.songs
  for select to anon, authenticated using (true);

drop policy if exists "queue readable by everyone" on public.queue;
create policy "queue readable by everyone" on public.queue
  for select to anon, authenticated using (true);

drop policy if exists "guests can request songs" on public.queue;
create policy "guests can request songs" on public.queue
  for insert to anon, authenticated with check (status = 'queued');

-- ---------------------------------------------------------------------
-- RPC: advance the queue atomically.
--   p_finished_id  the row that just ended (null on first start / resume)
--   p_outcome      'completed' (ENDED event) or 'skipped' (error / skip)
-- Returns the id of the row that is now 'playing' (or null if empty).
-- Idempotent: calling it twice for the same finished row is harmless.
-- ---------------------------------------------------------------------
create or replace function public.advance_queue(
  p_finished_id uuid default null,
  p_outcome     text default 'completed'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_next uuid;
begin
  if p_outcome not in ('completed', 'skipped') then
    raise exception 'invalid outcome %', p_outcome;
  end if;

  if p_finished_id is not null then
    update queue set status = p_outcome, finished_at = now()
     where id = p_finished_id and status = 'playing';
  end if;

  -- Something is still playing (e.g. another host tab already advanced):
  -- just report it instead of starting a second song.
  select id into v_next from queue where status = 'playing' limit 1;
  if v_next is not null then
    return v_next;
  end if;

  select id into v_next from queue
   where status = 'queued'
   order by created_at, id
   limit 1
   for update skip locked;

  if v_next is not null then
    update queue set status = 'playing', started_at = now() where id = v_next;
  end if;

  return v_next;
end $$;

-- ---------------------------------------------------------------------
-- RPC: request a song found via the YouTube fallback search.
-- Adds it to the catalog (or reuses it) and queues it in one call, so
-- guests never need direct INSERT rights on songs.
-- ---------------------------------------------------------------------
create or replace function public.request_youtube_song(
  p_video_id   text,
  p_title      text,
  p_artist     text,
  p_guest_name text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_song_id  uuid;
  v_queue_id uuid;
begin
  insert into songs (title, artist, youtube_video_id, tags)
  values (left(btrim(p_title), 200), left(coalesce(btrim(p_artist), ''), 200), p_video_id, '{youtube}')
  on conflict (youtube_video_id) do update set youtube_video_id = excluded.youtube_video_id
  returning id into v_song_id;

  insert into queue (song_id, guest_name) values (v_song_id, p_guest_name)
  returning id into v_queue_id;

  return v_queue_id;
end $$;

-- ---------------------------------------------------------------------
-- Housekeeping: drop finished rows older than 2 days. Free tier has a
-- 500 MB database cap; a karaoke night produces a few KB, but this keeps
-- it tidy forever. Run manually, or schedule with pg_cron:
--   select cron.schedule('purge-karaoke-queue', '0 6 * * *',
--                        'select public.purge_old_queue()');
-- ---------------------------------------------------------------------
create or replace function public.purge_old_queue()
returns integer language sql security definer set search_path = public as $$
  with gone as (
    delete from queue
     where status in ('completed', 'skipped')
       and finished_at < now() - interval '2 days'
    returning 1
  ) select count(*)::int from gone;
$$;

revoke execute on function public.purge_old_queue() from public, anon, authenticated;
grant  execute on function public.advance_queue(uuid, text)                   to anon, authenticated;
grant  execute on function public.request_youtube_song(text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Realtime: broadcast queue changes to the host + guests over WebSockets.
-- (songs is not published — the catalog doesn't need live updates, and
-- skipping it saves Realtime message quota.)
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'queue'
  ) then
    alter publication supabase_realtime add table public.queue;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Starter catalog. Replace/extend with karaoke (lyrics) versions — any
-- 11-character YouTube video ID works as long as the uploader allows
-- embedding. Non-embeddable videos are auto-skipped by the host.
-- ---------------------------------------------------------------------
insert into public.songs (title, artist, youtube_video_id, tags) values
  ('Never Gonna Give You Up', 'Rick Astley', 'dQw4w9WgXcQ', '{pop,english,80s}'),
  ('Bohemian Rhapsody',       'Queen',       'fJ9rUzIMcZQ', '{rock,english,70s}'),
  ('Despacito',               'Luis Fonsi ft. Daddy Yankee', 'kJQP7kiw5Fk', '{latin,spanish}'),
  ('Gangnam Style',           'PSY',         '9bZkp7q19f0', '{kpop,korean}')
on conflict (youtube_video_id) do nothing;
