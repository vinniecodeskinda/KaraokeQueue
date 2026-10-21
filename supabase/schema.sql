-- =====================================================================
-- Home Karaoke — Supabase schema (v3: rooms, members, passwords, kick)
-- Run this whole file in Supabase → SQL Editor → New query.
-- Idempotent: safe to re-run, and upgrades a v1/v2 database in place.
-- =====================================================================

create extension if not exists pg_trgm;                        -- fast ILIKE search
create extension if not exists pgcrypto with schema extensions; -- password hashing

-- ---------------------------------------------------------------------
-- rooms: one per party. No accounts — the device that creates a room
-- gets a secret host_key; only that key can advance/skip or kick.
-- Optional password (bcrypt hash). Guests never read this table directly.
-- ---------------------------------------------------------------------
create table if not exists public.rooms (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique check (code ~ '^[A-Z2-9]{5}$'),
  host_key       text not null,
  created_at     timestamptz not null default now(),
  last_active_at timestamptz not null default now()
);
alter table public.rooms add column if not exists name text;
update public.rooms set name = 'Karaoke Room' where name is null;
alter table public.rooms alter column name set default 'Karaoke Room';
alter table public.rooms alter column name set not null;
alter table public.rooms add column if not exists password_hash text;

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
-- members: who has joined each room (the host is a member too).
-- Each device proves who it is with a secret key kept in member_keys,
-- which guests can never read.
-- ---------------------------------------------------------------------
create table if not exists public.members (
  id        uuid primary key default gen_random_uuid(),
  room_id   uuid not null references public.rooms(id) on delete cascade,
  name      text not null check (char_length(btrim(name)) between 1 and 40),
  is_host   boolean not null default false,
  kicked    boolean not null default false,
  joined_at timestamptz not null default now()
);
create index if not exists members_room_idx on public.members (room_id);

create table if not exists public.member_keys (
  member_id uuid primary key references public.members(id) on delete cascade,
  key       text not null unique
);

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

-- v1 → v2: add room_id, drop room-less rows, require it.
alter table public.queue add column if not exists room_id uuid references public.rooms(id) on delete cascade;
delete from public.queue where room_id is null;
alter table public.queue alter column room_id set not null;
-- v2 → v3: who requested it (null for rows from before members existed).
alter table public.queue add column if not exists member_id uuid references public.members(id) on delete set null;

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
  if new.member_id is not null and (select count(*) from queue
       where room_id = new.room_id and status = 'queued' and member_id = new.member_id) >= 5 then
    raise exception 'You already have 5 songs waiting. Let someone else sing!';
  end if;
  new.guest_name := btrim(new.guest_name);
  new.status     := 'queued';     -- requests can never insert a 'playing' row
  new.created_at := now();        -- and can't jump the line with a fake timestamp
  update rooms set last_active_at = now() where id = new.room_id;
  return new;
end $$;

drop trigger if exists queue_limits on public.queue;
create trigger queue_limits before insert on public.queue
  for each row execute function public.enforce_queue_limits();

-- ---------------------------------------------------------------------
-- Row Level Security
-- anon may READ songs, queue and members. Every write goes through the
-- SECURITY DEFINER functions below, which check member/host keys and
-- room passwords. rooms + member_keys: no direct access at all.
-- ---------------------------------------------------------------------
alter table public.rooms       enable row level security;
alter table public.songs       enable row level security;
alter table public.queue       enable row level security;
alter table public.members     enable row level security;
alter table public.member_keys enable row level security;

revoke all on public.rooms, public.member_keys from anon, authenticated;
revoke insert, update, delete on public.queue, public.members, public.songs from anon, authenticated;

drop policy if exists "songs readable by everyone" on public.songs;
create policy "songs readable by everyone" on public.songs
  for select to anon, authenticated using (true);

drop policy if exists "queue readable by everyone" on public.queue;
create policy "queue readable by everyone" on public.queue
  for select to anon, authenticated using (true);

drop policy if exists "guests can request songs" on public.queue;   -- v2: direct inserts

drop policy if exists "members readable by everyone" on public.members;
create policy "members readable by everyone" on public.members
  for select to anon, authenticated using (true);

-- Old function signatures — replaced below.
drop function if exists public.advance_queue(uuid, text);
drop function if exists public.request_youtube_song(text, text, text, text);
drop function if exists public.request_youtube_song(uuid, text, text, text, text);
drop function if exists public.create_room();
drop function if exists public.get_room(text);

-- ---------------------------------------------------------------------
-- Internal helpers (not callable by guests)
-- ---------------------------------------------------------------------
create or replace function public.unique_member_name(p_room_id uuid, p_name text, p_except uuid default null)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_base text := left(coalesce(nullif(btrim(p_name), ''), 'Mystery Singer'), 36);
  v_name text := v_base;
  v_n    int  := 1;
begin
  while exists (
    select 1 from members m
     where m.room_id = p_room_id and not m.kicked and lower(m.name) = lower(v_name)
       and m.id is distinct from p_except
  ) loop
    v_n := v_n + 1;
    v_name := v_base || ' ' || v_n;
  end loop;
  return v_name;
end $$;

create or replace function public.add_member(p_room_id uuid, p_name text, p_is_host boolean)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_id   uuid;
  v_name text;
  v_key  text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if (select count(*) from members where room_id = p_room_id) >= 150 then
    raise exception 'This room is full.';
  end if;
  v_name := unique_member_name(p_room_id, p_name);
  insert into members (room_id, name, is_host) values (p_room_id, v_name, p_is_host)
  returning id into v_id;
  insert into member_keys (member_id, key) values (v_id, v_key);
  return json_build_object('member_id', v_id, 'member_key', v_key, 'name', v_name);
end $$;

-- ---------------------------------------------------------------------
-- RPC: create a room (optional name + password). The creator becomes the
-- host member. Returns the room plus host_key and member_key to keep.
-- ---------------------------------------------------------------------
create or replace function public.create_room(p_name text, p_password text, p_host_name text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_id     uuid;
  v_code   text;
  v_key    text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_name   text;
  v_member json;
begin
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
  v_name := left(coalesce(
    nullif(btrim(p_name), ''),
    left(coalesce(nullif(btrim(p_host_name), ''), 'Karaoke'), 40) || '''s Room'
  ), 60);
  insert into rooms (code, host_key, name, password_hash)
  values (
    v_code, v_key, v_name,
    case when coalesce(p_password, '') = '' then null
         else extensions.crypt(p_password, extensions.gen_salt('bf')) end
  )
  returning rooms.id into v_id;
  v_member := add_member(v_id, p_host_name, true);
  return json_build_object(
    'id', v_id, 'code', v_code, 'name', v_name, 'has_password', coalesce(p_password, '') <> '',
    'host_key', v_key,
    'member_id', v_member->>'member_id', 'member_key', v_member->>'member_key',
    'member_name', v_member->>'name'
  );
end $$;

-- ---------------------------------------------------------------------
-- RPC: public info about a room by code (case-insensitive). Null if none.
-- ---------------------------------------------------------------------
create or replace function public.get_room(p_code text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object('id', r.id, 'code', r.code, 'name', r.name,
                           'has_password', r.password_hash is not null)
    from rooms r where r.code = upper(btrim(p_code));
$$;

-- ---------------------------------------------------------------------
-- RPC: join a room, or re-enter with a member key this device already
-- has. Checks the password for new members (the host key skips it).
-- Kicked members are refused.
-- ---------------------------------------------------------------------
create or replace function public.join_room(
  p_code       text,
  p_password   text default null,
  p_name       text default null,
  p_member_key text default null,
  p_host_key   text default null
) returns json
language plpgsql security definer set search_path = public as $$
declare
  r        rooms%rowtype;
  v_mem    members%rowtype;
  v_host   boolean;
  v_member json;
begin
  select * into r from rooms where code = upper(btrim(p_code));
  if not found then
    raise exception 'Room not found';
  end if;

  if p_member_key is not null then
    select m.* into v_mem
      from member_keys k join members m on m.id = k.member_id
     where k.key = p_member_key and m.room_id = r.id;
    if found then
      if v_mem.kicked then
        raise exception 'You were removed from this party by the host.';
      end if;
      return json_build_object(
        'room', json_build_object('id', r.id, 'code', r.code, 'name', r.name),
        'member_id', v_mem.id, 'member_key', p_member_key, 'name', v_mem.name, 'is_host', v_mem.is_host);
    end if;
  end if;

  v_host := p_host_key is not null and p_host_key = r.host_key;

  -- One host member per room: a host device that lost its member key gets
  -- the existing host membership back instead of a second "host".
  if v_host then
    select m.* into v_mem from members m
     where m.room_id = r.id and m.is_host and not m.kicked
     order by m.joined_at limit 1;
    if found then
      return json_build_object(
        'room', json_build_object('id', r.id, 'code', r.code, 'name', r.name),
        'member_id', v_mem.id,
        'member_key', (select k.key from member_keys k where k.member_id = v_mem.id),
        'name', v_mem.name, 'is_host', true);
    end if;
  end if;

  if r.password_hash is not null and not v_host then
    if coalesce(p_password, '') = '' then
      raise exception 'This room needs a password';
    end if;
    if extensions.crypt(p_password, r.password_hash) <> r.password_hash then
      raise exception 'Wrong password';
    end if;
  end if;

  update rooms set last_active_at = now() where id = r.id;
  v_member := add_member(r.id, p_name, v_host);
  return json_build_object(
    'room', json_build_object('id', r.id, 'code', r.code, 'name', r.name),
    'member_id', v_member->>'member_id', 'member_key', v_member->>'member_key',
    'name', v_member->>'name', 'is_host', v_host);
end $$;

-- ---------------------------------------------------------------------
-- RPC: change your display name in a room. Returns the (de-duplicated)
-- name actually used.
-- ---------------------------------------------------------------------
create or replace function public.rename_member(p_member_key text, p_name text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_mem  members%rowtype;
  v_name text;
begin
  select m.* into v_mem from member_keys k join members m on m.id = k.member_id
   where k.key = p_member_key and not m.kicked;
  if not found then
    raise exception 'You are not in this room';
  end if;
  v_name := unique_member_name(v_mem.room_id, p_name, v_mem.id);
  update members set name = v_name where id = v_mem.id;
  return v_name;
end $$;

-- ---------------------------------------------------------------------
-- RPC: host removes someone. Their waiting songs are dropped and their
-- member key stops working. The host can't kick themself.
-- ---------------------------------------------------------------------
create or replace function public.kick_member(p_room_id uuid, p_host_key text, p_member_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from rooms where id = p_room_id and host_key = p_host_key) then
    raise exception 'Only the host can remove people';
  end if;
  update members set kicked = true
   where id = p_member_id and room_id = p_room_id and not is_host;
  update queue set status = 'skipped', finished_at = now()
   where member_id = p_member_id and room_id = p_room_id and status = 'queued';
end $$;

-- ---------------------------------------------------------------------
-- RPC: request a catalog song (any non-kicked member, incl. the host).
-- ---------------------------------------------------------------------
create or replace function public.request_song(p_member_key text, p_song_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_mem members%rowtype;
  v_id  uuid;
begin
  select m.* into v_mem from member_keys k join members m on m.id = k.member_id
   where k.key = p_member_key;
  if not found then
    raise exception 'Join the room before requesting songs';
  end if;
  if v_mem.kicked then
    raise exception 'You were removed from this party by the host.';
  end if;
  insert into queue (room_id, song_id, guest_name, member_id)
  values (v_mem.room_id, p_song_id, v_mem.name, v_mem.id)
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- RPC: request a YouTube search result. Adds it to the shared catalog
-- (or reuses it), then queues it like request_song.
-- ---------------------------------------------------------------------
create or replace function public.request_youtube_song(
  p_member_key text,
  p_video_id   text,
  p_title      text,
  p_artist     text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_song_id uuid;
begin
  if not exists (select 1 from member_keys k join members m on m.id = k.member_id
                  where k.key = p_member_key and not m.kicked) then
    raise exception 'Join the room before requesting songs';
  end if;
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
  return request_song(p_member_key, v_song_id);
end $$;

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
-- Housekeeping: drop rooms idle for 2+ days (members + queue cascade).
-- Run manually, or schedule with pg_cron:
--   select cron.schedule('purge-karaoke', '0 6 * * *', 'select public.purge_old_queue()');
-- ---------------------------------------------------------------------
create or replace function public.purge_old_queue()
returns integer language sql security definer set search_path = public as $$
  with gone as (
    delete from rooms where last_active_at < now() - interval '2 days' returning 1
  ) select count(*)::int from gone;
$$;

revoke execute on function public.purge_old_queue()                         from public, anon, authenticated;
revoke execute on function public.enforce_queue_limits()                    from public, anon, authenticated;
revoke execute on function public.unique_member_name(uuid, text, uuid)      from public, anon, authenticated;
revoke execute on function public.add_member(uuid, text, boolean)           from public, anon, authenticated;
grant  execute on function public.create_room(text, text, text)             to anon, authenticated;
grant  execute on function public.get_room(text)                            to anon, authenticated;
grant  execute on function public.join_room(text, text, text, text, text)   to anon, authenticated;
grant  execute on function public.rename_member(text, text)                 to anon, authenticated;
grant  execute on function public.kick_member(uuid, text, uuid)             to anon, authenticated;
grant  execute on function public.request_song(text, uuid)                  to anon, authenticated;
grant  execute on function public.request_youtube_song(text, text, text, text) to anon, authenticated;
grant  execute on function public.advance_queue(uuid, text, uuid, text)     to anon, authenticated;

-- ---------------------------------------------------------------------
-- Realtime: broadcast queue + member changes over WebSockets (clients
-- filter by room_id). songs/rooms are not published.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'queue') then
    alter publication supabase_realtime add table public.queue;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'members') then
    alter publication supabase_realtime add table public.members;
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
