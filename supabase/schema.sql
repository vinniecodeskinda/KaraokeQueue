-- =====================================================================
-- Home Karaoke — Supabase schema (v2: rooms)
-- Run this whole file in Supabase → SQL Editor → New query.
-- Idempotent: safe to re-run, and upgrades a v1 database in place
-- (v1 queue rows have no room, so they are discarded).
-- =====================================================================

create extension if not exists pg_trgm;   -- fast ILIKE search on title/artist

-- ---------------------------------------------------------------------
-- rooms: one per party. No accounts — the device that creates a room
-- gets a secret host_key; only that key can advance/skip the queue.
-- Guests never read this table directly (see get_room()).
-- ---------------------------------------------------------------------
create table if not exists public.rooms (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique check (code ~ '^[A-Z2-9]{5}$'),
  host_key       text not null,
  created_at     timestamptz not null default now(),
  last_active_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- songs: the shared catalog
-- ---------------------------------------------------------------------
create table if not exists public.songs (
  id               uuid primary key default gen_random_uuid(),
  title            text not null check (char_length(title) between 1 and 200),
  artist           text not null default '' check (char_length(artist) <= 200),
  youtube_video_id text not null unique check (youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'),
  tags             text[] not null default '{}',     -- e.g. {pop,english,karaoke}
  created_at       timestamptz not null default now()
);

create index if not exists songs_title_trgm  on public.songs using gin (title  gin_trgm_ops);
create index if not exists songs_artist_trgm on public.songs using gin (artist gin_trgm_ops);
create index if not exists songs_tags_gin    on public.songs using gin (tags);

-- ---------------------------------------------------------------------
-- queue: requests per room, ordered by created_at
-- ---------------------------------------------------------------------
create table if not exists public.queue (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid references public.rooms(id) on delete cascade,
  song_id     uuid not null references public.songs(id) on delete cascade,
  guest_name  text not null check (char_length(btrim(guest_name)) between 1 and 40),
  status      text not null default 'queued'
              check (status in ('queued', 'playing', 'completed', 'skipped')),
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz
);

-- v1 → v2 upgrade: add room_id, drop room-less rows, require it.
alter table public.queue add column if not exists room_id uuid references public.rooms(id) on delete cascade;
delete from public.queue where room_id is null;
alter table public.queue alter column room_id set not null;

drop index if exists public.queue_active_idx;
drop index if exists public.queue_single_playing;
create index if not exists queue_room_active_idx on public.queue (room_id, status, created_at)
  where status in ('queued', 'playing');

-- At most ONE 'playing' row per room. Makes double-advances (two host
-- tabs, a double-fired ENDED event) fail safely.
create unique index if not exists queue_single_playing_per_room
  on public.queue (room_id) where status = 'playing';

-- ---------------------------------------------------------------------
-- Guard rails: keep free-tier usage tiny and stop one phone flooding
-- a room. SECURITY DEFINER so it can bump rooms.last_active_at.
-- ---------------------------------------------------------------------
create or replace function public.enforce_queue_limits()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from queue where room_id = new.room_id and status = 'queued') >= 200 then
    raise exception 'The queue is full (200 songs). Try again later.';
  end if;
  if (select count(*) from queue
       where room_id = new.room_id and status = 'queued'
         and lower(guest_name) = lower(btrim(new.guest_name))) >= 5 then
    raise exception 'You already have 5 songs waiting. Let someone else sing!';
  end if;
  new.guest_name := btrim(new.guest_name);
  new.status     := 'queued';     -- guests can never insert a 'playing' row
  new.created_at := now();        -- and can't jump the line with a fake timestamp
  update rooms set last_active_at = now() where id = new.room_id;
  return new;
end $$;

drop trigger if exists queue_limits on public.queue;
create trigger queue_limits before insert on public.queue
  for each row execute function public.enforce_queue_limits();

-- ---------------------------------------------------------------------
-- Row Level Security
-- anon may: read songs, read queue rows, insert queue rows.
-- rooms: no direct access at all (host_key must stay secret).
-- ---------------------------------------------------------------------
alter table public.rooms enable row level security;
alter table public.songs enable row level security;
alter table public.queue enable row level security;

revoke all on public.rooms from anon, authenticated;

drop policy if exists "songs readable by everyone" on public.songs;
create policy "songs readable by everyone" on public.songs
  for select to anon, authenticated using (true);

drop policy if exists "queue readable by everyone" on public.queue;
create policy "queue readable by everyone" on public.queue
  for select to anon, authenticated using (true);

drop policy if exists "guests can request songs" on public.queue;
create policy "guests can request songs" on public.queue
  for insert to anon, authenticated with check (status = 'queued');

-- v1 function signatures (no room) — replaced below.
drop function if exists public.advance_queue(uuid, text);
drop function if exists public.request_youtube_song(text, text, text, text);

-- ---------------------------------------------------------------------
-- RPC: create a room. Returns its id, a 5-char code (no 0/O/1/I/L
-- look-alikes) and the secret host key for this device to keep.
-- ---------------------------------------------------------------------
create or replace function public.create_room()
returns table (id uuid, code text, host_key text)
language plpgsql security definer set search_path = public as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_id   uuid;
  v_code text;
  v_key  text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  -- Free-tier abuse guard: cap room creation rate globally.
  if (select count(*) from rooms r where r.created_at > now() - interval '1 hour') >= 300 then
    raise exception 'Too many rooms created recently. Try again in a bit.';
  end if;
  loop
    v_code := '';
    for i in 1..5 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from rooms r where r.code = v_code);
  end loop;
  insert into rooms (code, host_key) values (v_code, v_key) returning rooms.id into v_id;
  return query select v_id, v_code, v_key;
end $$;

-- ---------------------------------------------------------------------
-- RPC: look up a room by code (case-insensitive). Never exposes host_key.
-- ---------------------------------------------------------------------
create or replace function public.get_room(p_code text)
returns table (id uuid, code text)
language sql stable security definer set search_path = public as $$
  select r.id, r.code from rooms r where r.code = upper(btrim(p_code));
$$;

-- ---------------------------------------------------------------------
-- RPC: advance a room's queue atomically (host only).
--   p_finished_id  the row that just ended (null on first start / resume)
--   p_outcome      'completed' (ENDED event) or 'skipped' (error / skip)
-- Returns the id of the row now 'playing' (or null if the queue is empty).
-- Idempotent: calling it twice for the same finished row is harmless.
-- ---------------------------------------------------------------------
create or replace function public.advance_queue(
  p_room_id     uuid,
  p_host_key    text,
  p_finished_id uuid default null,
  p_outcome     text default 'completed'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_next uuid;
begin
  if not exists (select 1 from rooms where id = p_room_id and host_key = p_host_key) then
    raise exception 'Only the host can control this room';
  end if;
  if p_outcome not in ('completed', 'skipped') then
    raise exception 'invalid outcome %', p_outcome;
  end if;

  update rooms set last_active_at = now() where id = p_room_id;

  if p_finished_id is not null then
    update queue set status = p_outcome, finished_at = now()
     where id = p_finished_id and room_id = p_room_id and status = 'playing';
  end if;

  -- Something is still playing (e.g. another host tab already advanced).
  select id into v_next from queue where room_id = p_room_id and status = 'playing' limit 1;
  if v_next is not null then
    return v_next;
  end if;

  select id into v_next from queue
   where room_id = p_room_id and status = 'queued'
   order by created_at, id
   limit 1
   for update skip locked;

  if v_next is not null then
    update queue set status = 'playing', started_at = now() where id = v_next;
  end if;

  return v_next;
end $$;

-- ---------------------------------------------------------------------
-- RPC: request a song found via the YouTube fallback search. Adds it to
-- the shared catalog (or reuses it) and queues it in one call.
-- ---------------------------------------------------------------------
create or replace function public.request_youtube_song(
  p_room_id    uuid,
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
  values (
    left(btrim(p_title), 200),
    left(coalesce(btrim(p_artist), ''), 200),
    p_video_id,
    case when p_title ilike '%karaoke%' or p_title ilike '%instrumental%'
         then '{youtube,karaoke}'::text[] else '{youtube}'::text[] end
  )
  on conflict (youtube_video_id) do update set youtube_video_id = excluded.youtube_video_id
  returning id into v_song_id;

  insert into queue (room_id, song_id, guest_name) values (p_room_id, v_song_id, p_guest_name)
  returning id into v_queue_id;

  return v_queue_id;
end $$;

-- ---------------------------------------------------------------------
-- Housekeeping: drop rooms idle for 2+ days (their queue cascades).
-- Run manually, or schedule with pg_cron:
--   select cron.schedule('purge-karaoke', '0 6 * * *', 'select public.purge_old_queue()');
-- ---------------------------------------------------------------------
create or replace function public.purge_old_queue()
returns integer language sql security definer set search_path = public as $$
  with gone as (
    delete from rooms where last_active_at < now() - interval '2 days' returning 1
  ) select count(*)::int from gone;
$$;

revoke execute on function public.purge_old_queue()   from public, anon, authenticated;
revoke execute on function public.enforce_queue_limits() from public, anon, authenticated;
grant  execute on function public.create_room()                                     to anon, authenticated;
grant  execute on function public.get_room(text)                                    to anon, authenticated;
grant  execute on function public.advance_queue(uuid, text, uuid, text)             to anon, authenticated;
grant  execute on function public.request_youtube_song(uuid, text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Realtime: broadcast queue changes over WebSockets (clients filter by
-- room_id). songs/rooms are not published, saving message quota.
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
-- Starter catalog. Tag karaoke/lyric versions with 'karaoke' so the
-- "Prioritize karaoke" toggle ranks them first. Non-embeddable videos
-- are auto-skipped by the host.
-- ---------------------------------------------------------------------
insert into public.songs (title, artist, youtube_video_id, tags) values
  ('Never Gonna Give You Up', 'Rick Astley', 'dQw4w9WgXcQ', '{pop,english,80s}'),
  ('Bohemian Rhapsody',       'Queen',       'fJ9rUzIMcZQ', '{rock,english,70s}'),
  ('Despacito',               'Luis Fonsi ft. Daddy Yankee', 'kJQP7kiw5Fk', '{latin,spanish}'),
  ('Gangnam Style',           'PSY',         '9bZkp7q19f0', '{kpop,korean}')
on conflict (youtube_video_id) do nothing;
