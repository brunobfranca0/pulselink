-- =============================================================================
-- PulseLink cloud — Supabase-native backend.
--
-- The desktop app talks to Supabase ONLY with the public anon key + the signed-in user's
-- session. No service_role key or database password ever leaves this database:
--   * Row Level Security decides what each user can read.
--   * Writes that need cross-user checks (redeeming an invite, approving a guest, setting
--     permissions…) go through the SECURITY DEFINER functions below, which validate auth.uid().
--   * WebRTC signaling uses Realtime *private* channels authorized by session membership.
--
-- Idempotent: safe to run again after edits (npm run cloud:migrate).
-- =============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '',
  username text not null,
  discriminator text not null default lpad((floor(random() * 9000) + 1000)::text, 4, '0'),
  plan text not null default 'free',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, username)
  values (
    new.id,
    coalesce(new.email, ''),
    left(coalesce(nullif(trim(new.raw_user_meta_data->>'username'), ''), split_part(coalesce(new.email, 'user'), '@', 1)), 32)
  )
  on conflict (id) do update set email = excluded.email, updated_at = now();
  return new;
end;
$$;

-- Backfill accounts created before this trigger existed.
insert into public.profiles (id, email, username)
select u.id, coalesce(u.email, ''), left(split_part(coalesce(u.email, 'user'), '@', 1), 32)
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
drop policy if exists "Users can read all profiles" on public.profiles;
drop policy if exists "Authenticated users can read profiles" on public.profiles;
create policy "Authenticated users can read profiles" on public.profiles
  for select to authenticated using (true);
drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile" on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- Emails are never readable by other users; only the username can be changed.
revoke all on public.profiles from anon;
revoke select, insert, update, delete on public.profiles from authenticated;
grant select (id, username, discriminator, plan, created_at, updated_at) on public.profiles to authenticated;
grant update (username, updated_at) on public.profiles to authenticated;

-- ----------------------------------------------------------------------------- tables
create table if not exists public.pl_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 64),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists pl_devices_user_idx on public.pl_devices (user_id);

create table if not exists public.pl_hosts (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null unique references public.pl_devices(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 64),
  status text not null default 'offline' check (status in ('online', 'offline', 'busy')),
  capabilities jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists pl_hosts_user_idx on public.pl_hosts (user_id);

-- owner_id grants friend_id visibility of owner's computers + default permissions.
create table if not exists public.pl_friends (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  friend_id uuid not null references public.profiles(id) on delete cascade,
  keyboard boolean not null default false,
  mouse boolean not null default false,
  auto_connect boolean not null default false,
  created_at timestamptz not null default now(),
  unique (owner_id, friend_id),
  check (owner_id <> friend_id)
);
create index if not exists pl_friends_friend_idx on public.pl_friends (friend_id);

create table if not exists public.pl_invites (
  code text primary key,
  host_id uuid not null references public.pl_hosts(id) on delete cascade,
  created_by uuid not null references public.profiles(id) on delete cascade,
  max_uses integer not null default 5 check (max_uses between 1 and 50),
  use_count integer not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.pl_sessions (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.pl_hosts(id) on delete cascade,
  host_user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'active', 'denied', 'ended')),
  -- Shared only with members; encrypts signaling end-to-end on top of private channels.
  session_key text not null default encode(gen_random_bytes(32), 'hex'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists pl_sessions_host_idx on public.pl_sessions (host_id, status);

create table if not exists public.pl_participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.pl_sessions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  device_id uuid not null references public.pl_devices(id) on delete cascade,
  role text not null check (role in ('host', 'guest')),
  presence text not null default 'pending' check (presence in ('pending', 'connected', 'removed')),
  keyboard boolean not null default false,
  mouse boolean not null default false,
  created_at timestamptz not null default now(),
  unique (session_id, device_id)
);
create index if not exists pl_participants_user_idx on public.pl_participants (user_id);
create index if not exists pl_participants_session_idx on public.pl_participants (session_id);

-- ----------------------------------------------------------------------------- helpers
create or replace function public.pl_is_session_member(p_session uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from pl_participants
    where session_id = p_session and user_id = auth.uid() and presence <> 'removed'
  );
$$;

-- Hosts of `p_owner` are visible to the owner and to people the owner added as friends.
create or replace function public.pl_can_see_owner(p_owner uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_owner = auth.uid()
      or exists (select 1 from pl_friends where owner_id = p_owner and friend_id = auth.uid());
$$;

create or replace function public.pl_require_user()
returns uuid
language plpgsql
stable
as $$
begin
  if auth.uid() is null then
    raise exception 'Faça login para continuar' using errcode = '28000';
  end if;
  return auth.uid();
end;
$$;

-- ----------------------------------------------------------------------------- RLS
alter table public.pl_devices enable row level security;
alter table public.pl_hosts enable row level security;
alter table public.pl_friends enable row level security;
alter table public.pl_invites enable row level security;
alter table public.pl_sessions enable row level security;
alter table public.pl_participants enable row level security;

revoke all on public.pl_devices, public.pl_hosts, public.pl_friends, public.pl_invites,
  public.pl_sessions, public.pl_participants from anon;

drop policy if exists "own devices" on public.pl_devices;
create policy "own devices" on public.pl_devices for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "visible hosts" on public.pl_hosts;
create policy "visible hosts" on public.pl_hosts for select to authenticated
  using (public.pl_can_see_owner(user_id));
drop policy if exists "own hosts write" on public.pl_hosts;
create policy "own hosts write" on public.pl_hosts for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.pl_devices d where d.id = device_id and d.user_id = auth.uid())
  );
drop policy if exists "own hosts update" on public.pl_hosts;
create policy "own hosts update" on public.pl_hosts for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own hosts delete" on public.pl_hosts;
create policy "own hosts delete" on public.pl_hosts for delete to authenticated
  using (user_id = auth.uid());

drop policy if exists "own friends" on public.pl_friends;
create policy "own friends" on public.pl_friends for select to authenticated
  using (owner_id = auth.uid());
drop policy if exists "own friends update" on public.pl_friends;
create policy "own friends update" on public.pl_friends for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "own friends delete" on public.pl_friends;
create policy "own friends delete" on public.pl_friends for delete to authenticated
  using (owner_id = auth.uid());

drop policy if exists "own invites" on public.pl_invites;
create policy "own invites" on public.pl_invites for select to authenticated
  using (created_by = auth.uid());
drop policy if exists "own invites delete" on public.pl_invites;
create policy "own invites delete" on public.pl_invites for delete to authenticated
  using (created_by = auth.uid());

drop policy if exists "member sessions" on public.pl_sessions;
create policy "member sessions" on public.pl_sessions for select to authenticated
  using (public.pl_is_session_member(id));

drop policy if exists "member participants" on public.pl_participants;
create policy "member participants" on public.pl_participants for select to authenticated
  using (public.pl_is_session_member(session_id));

-- Sessions, participants and invites are only ever written through the functions below;
-- elsewhere only the columns that make sense are writable.
revoke insert, update, delete on public.pl_sessions, public.pl_participants, public.pl_invites from authenticated;
revoke insert, update on public.pl_friends from authenticated;
grant update (keyboard, mouse, auto_connect) on public.pl_friends to authenticated;
revoke update on public.pl_hosts from authenticated;
grant update (name, status, capabilities, updated_at) on public.pl_hosts to authenticated;
revoke update on public.pl_devices from authenticated;
grant update (name, last_seen_at) on public.pl_devices to authenticated;

-- ----------------------------------------------------------------------------- RPCs
create or replace function public.pl_create_invite(p_host_id uuid, p_max_uses int default 5, p_ttl_seconds int default 7200)
returns public.pl_invites
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := pl_require_user();
  inv pl_invites;
begin
  if not exists (select 1 from pl_hosts where id = p_host_id and user_id = me) then
    raise exception 'Host não encontrado' using errcode = '42501';
  end if;
  insert into pl_invites (code, host_id, created_by, max_uses, expires_at)
  values (
    upper(encode(gen_random_bytes(5), 'hex')),
    p_host_id,
    me,
    least(greatest(coalesce(p_max_uses, 5), 1), 50),
    now() + make_interval(secs => least(greatest(coalesce(p_ttl_seconds, 7200), 60), 7 * 24 * 3600))
  )
  returning * into inv;
  return inv;
end;
$$;

-- Internal: creates a session between the caller's device and a host.
create or replace function public.pl_open_session(p_host pl_hosts, p_device_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := pl_require_user();
  f pl_friends;
  sid uuid;
  auto boolean;
begin
  if not exists (select 1 from pl_devices where id = p_device_id and user_id = me) then
    raise exception 'Dispositivo inválido' using errcode = '42501';
  end if;
  if p_host.user_id = me then
    raise exception 'Este computador é seu' using errcode = '22023';
  end if;
  if p_host.status = 'offline' or p_host.updated_at < now() - interval '2 minutes' then
    raise exception 'O computador está offline' using errcode = '55000';
  end if;

  select * into f from pl_friends where owner_id = p_host.user_id and friend_id = me;
  auto := coalesce(f.auto_connect, false);

  insert into pl_sessions (host_id, host_user_id, status)
  values (p_host.id, p_host.user_id, case when auto then 'active' else 'pending' end)
  returning id into sid;

  insert into pl_participants (session_id, user_id, device_id, role, presence, keyboard, mouse)
  values
    (sid, p_host.user_id, p_host.device_id, 'host', 'connected', true, true),
    -- Friends get their saved permissions; everyone else starts view-only.
    (sid, me, p_device_id, 'guest', case when auto then 'connected' else 'pending' end,
     coalesce(f.keyboard, false), coalesce(f.mouse, false));
  return sid;
end;
$$;
revoke execute on function public.pl_open_session(pl_hosts, uuid) from public, anon, authenticated;

create or replace function public.pl_redeem_invite(p_code text, p_device_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := pl_require_user();
  inv pl_invites;
  h pl_hosts;
begin
  select * into inv from pl_invites where code = upper(trim(p_code)) for update;
  if not found or inv.expires_at < now() or inv.use_count >= inv.max_uses then
    raise exception 'Código inválido ou expirado' using errcode = '22023';
  end if;
  update pl_invites set use_count = use_count + 1 where code = inv.code;
  select * into h from pl_hosts where id = inv.host_id;
  return pl_open_session(h, p_device_id);
end;
$$;

create or replace function public.pl_connect_host(p_host_id uuid, p_device_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := pl_require_user();
  h pl_hosts;
begin
  select * into h from pl_hosts where id = p_host_id;
  if not found or not pl_can_see_owner(h.user_id) then
    raise exception 'Computador não encontrado' using errcode = '42501';
  end if;
  return pl_open_session(h, p_device_id);
end;
$$;

create or replace function public.pl_require_session_host(p_session_id uuid)
returns pl_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  s pl_sessions;
begin
  select * into s from pl_sessions where id = p_session_id;
  if not found or s.host_user_id <> pl_require_user() then
    raise exception 'Somente o host pode fazer isso' using errcode = '42501';
  end if;
  return s;
end;
$$;
revoke execute on function public.pl_require_session_host(uuid) from public, anon, authenticated;

create or replace function public.pl_approve_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s pl_sessions := pl_require_session_host(p_session_id);
begin
  if s.status <> 'pending' then
    raise exception 'A sessão não está aguardando aprovação' using errcode = '55000';
  end if;
  update pl_sessions set status = 'active', updated_at = now() where id = s.id;
  update pl_participants set presence = 'connected' where session_id = s.id and role = 'guest' and presence = 'pending';
end;
$$;

create or replace function public.pl_deny_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s pl_sessions := pl_require_session_host(p_session_id);
begin
  update pl_sessions set status = 'denied', updated_at = now(), ended_at = now()
  where id = s.id and status = 'pending';
end;
$$;

create or replace function public.pl_end_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pl_require_user();
  if not pl_is_session_member(p_session_id) then
    raise exception 'Você não participa desta sessão' using errcode = '42501';
  end if;
  update pl_sessions set status = 'ended', updated_at = now(), ended_at = now()
  where id = p_session_id and status in ('pending', 'active');
end;
$$;

create or replace function public.pl_set_permissions(p_participant_id uuid, p_keyboard boolean, p_mouse boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  p pl_participants;
begin
  select * into p from pl_participants where id = p_participant_id;
  if not found then
    raise exception 'Participante não encontrado' using errcode = '42501';
  end if;
  perform pl_require_session_host(p.session_id);
  if p.role <> 'guest' then
    raise exception 'Só é possível alterar permissões de convidados' using errcode = '22023';
  end if;
  update pl_participants set keyboard = coalesce(p_keyboard, false), mouse = coalesce(p_mouse, false)
  where id = p.id;
end;
$$;

create or replace function public.pl_kick(p_participant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  p pl_participants;
begin
  select * into p from pl_participants where id = p_participant_id;
  if not found then
    raise exception 'Participante não encontrado' using errcode = '42501';
  end if;
  perform pl_require_session_host(p.session_id);
  if p.role <> 'guest' then
    raise exception 'O host não pode ser removido' using errcode = '22023';
  end if;
  update pl_participants set presence = 'removed', keyboard = false, mouse = false where id = p.id;
end;
$$;

-- Adds a friend by "username#1234" or by one of their device IDs (full or 8+ char prefix).
create or replace function public.pl_add_friend(p_input text)
returns public.pl_friends
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := pl_require_user();
  target uuid;
  clean text := trim(coalesce(p_input, ''));
  uname text;
  tag text;
  fr pl_friends;
begin
  if clean ~ '#\d{4}$' then
    uname := split_part(clean, '#', 1);
    tag := split_part(clean, '#', 2);
    select id into target from profiles where lower(username) = lower(uname) and discriminator = tag;
  elsif char_length(clean) >= 8 and clean ~* '^[0-9a-f-]+$' then
    select user_id into target from pl_devices where id::text ilike lower(clean) || '%' limit 1;
  end if;
  if target is null then
    raise exception 'Usuário não encontrado. Use usuario#1234 ou o ID do dispositivo.' using errcode = '22023';
  end if;
  if target = me then
    raise exception 'Você não pode adicionar a si mesmo' using errcode = '22023';
  end if;
  insert into pl_friends (owner_id, friend_id) values (me, target)
  on conflict (owner_id, friend_id) do update set owner_id = excluded.owner_id
  returning * into fr;
  return fr;
end;
$$;

-- Functions are executable by PUBLIC by default; restrict them to signed-in users.
do $$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'pl\_%'
  loop
    execute format('revoke execute on function %s from public, anon', fn);
  end loop;
end $$;
grant execute on function public.pl_require_user() to authenticated;
grant execute on function
  public.pl_create_invite(uuid, int, int),
  public.pl_redeem_invite(text, uuid),
  public.pl_connect_host(uuid, uuid),
  public.pl_approve_session(uuid),
  public.pl_deny_session(uuid),
  public.pl_end_session(uuid),
  public.pl_set_permissions(uuid, boolean, boolean),
  public.pl_kick(uuid),
  public.pl_add_friend(text),
  public.pl_is_session_member(uuid),
  public.pl_can_see_owner(uuid)
to authenticated;

-- ----------------------------------------------------------------------------- realtime
-- Private broadcast channels "pl:<session id>" are usable only by that session's members.
drop policy if exists "pulselink members read" on realtime.messages;
create policy "pulselink members read" on realtime.messages for select to authenticated
  using (
    realtime.topic() ~ '^pl:[0-9a-f-]{36}$'
    and public.pl_is_session_member(substring(realtime.topic() from 4)::uuid)
  );
drop policy if exists "pulselink members write" on realtime.messages;
create policy "pulselink members write" on realtime.messages for insert to authenticated
  with check (
    realtime.topic() ~ '^pl:[0-9a-f-]{36}$'
    and public.pl_is_session_member(substring(realtime.topic() from 4)::uuid)
  );

-- Live updates for the app (RLS still applies to change events).
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['pl_sessions', 'pl_participants', 'pl_hosts'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
