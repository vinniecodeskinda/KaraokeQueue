-- v3 → v4: one host per room, host heartbeat + automatic handover, rooms
-- close when everyone leaves. Same definitions as supabase/schema.sql
-- (which stays the full, from-scratch install script).

alter table public.rooms add column if not exists host_seen_at timestamptz not null default now();

update public.members m set is_host = false
 where m.is_host
   and m.id <> (select h.id from public.members h
                 where h.room_id = m.room_id and h.is_host
                 order by h.joined_at, h.id limit 1);
create unique index if not exists members_one_host_per_room
  on public.members (room_id) where is_host;

create or replace function public.add_member(p_room_id uuid, p_name text, p_is_host boolean)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_id   uuid;
  v_name text;
  v_key  text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if (select count(*) from members
       where room_id = p_room_id and joined_at > now() - interval '12 hours') >= 150 then
    raise exception 'This room is full.';
  end if;
  v_name := unique_member_name(p_room_id, p_name);
  insert into members (room_id, name, is_host) values (p_room_id, v_name, p_is_host)
  returning id into v_id;
  insert into member_keys (member_id, key) values (v_id, v_key);
  return json_build_object('member_id', v_id, 'member_key', v_key, 'name', v_name);
end $$;

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
  delete from rooms r where r.host_seen_at < now() - interval '10 minutes';
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

create or replace function public.get_room(p_code text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object('id', r.id, 'code', r.code, 'name', r.name,
                           'has_password', r.password_hash is not null,
                           'open', r.host_seen_at > now() - interval '2 minutes')
    from rooms r where r.code = upper(btrim(p_code));
$$;

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
  if r.host_seen_at < now() - interval '2 minutes' then
    raise exception 'This room has closed — everyone left.';
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

create or replace function public.host_heartbeat(p_room_id uuid, p_host_key text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update rooms set host_seen_at = now(), last_active_at = now()
   where id = p_room_id and host_key = p_host_key;
  if not found then
    raise exception 'You are no longer the host of this room';
  end if;
end $$;

create or replace function public.claim_host(p_member_key text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_mem  members%rowtype;
  v_room uuid;
  v_key  text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  select m.* into v_mem from member_keys k join members m on m.id = k.member_id
   where k.key = p_member_key and not m.kicked;
  if not found then
    raise exception 'You are not in this room';
  end if;
  update rooms set host_key = v_key, host_seen_at = now(), last_active_at = now()
   where id = v_mem.room_id and host_seen_at < now() - interval '45 seconds'
  returning id into v_room;
  if v_room is null then
    raise exception 'The host is still here';
  end if;
  update members set is_host = false where room_id = v_room and is_host;
  update members set is_host = true where id = v_mem.id;
  return json_build_object('room_id', v_room, 'host_key', v_key);
end $$;

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

  update rooms set last_active_at = now(), host_seen_at = now() where id = p_room_id;

  if p_finished_id is not null then
    update queue set status = p_outcome, finished_at = now()
     where id = p_finished_id and room_id = p_room_id and status = 'playing';
  end if;

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

create or replace function public.purge_old_queue()
returns integer language sql security definer set search_path = public as $$
  with gone as (
    delete from rooms where host_seen_at < now() - interval '10 minutes' returning 1
  ) select count(*)::int from gone;
$$;

grant execute on function public.host_heartbeat(uuid, text) to anon, authenticated;
grant execute on function public.claim_host(text)           to anon, authenticated;
