-- PulseLink Parsec-like + Moonlight local signaling schema (SQLite v1 / Postgres-compatible types noted)
-- Access: every row owned by a device; routes enforce host ownership and participant membership.

pragma foreign_keys = on;

create table if not exists devices (
  id text primary key, -- uuid
  display_name text not null,
  token_hash text not null unique,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table if not exists hosts (
  id text primary key,
  owner_device_id text not null references devices(id) on delete cascade,
  name text not null,
  status text not null default 'offline'
    check (status in ('offline', 'online', 'busy')),
  capabilities_json text not null default '{}',
  media_endpoint text, -- "ip:port" advertised after approve (LAN v1)
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create index if not exists hosts_owner_idx on hosts (owner_device_id);
create index if not exists hosts_status_idx on hosts (status);

create table if not exists invitations (
  id text primary key,
  host_id text not null references hosts(id) on delete cascade,
  code text not null unique,
  max_uses integer not null default 1 check (max_uses > 0),
  use_count integer not null default 0 check (use_count >= 0),
  expires_at text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  check (use_count <= max_uses)
);
create index if not exists invitations_host_idx on invitations (host_id);
create index if not exists invitations_expires_idx on invitations (expires_at);

create table if not exists sessions (
  id text primary key,
  host_id text not null references hosts(id) on delete cascade,
  invitation_id text references invitations(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'active', 'denied', 'ended')),
  mode text not null default 'parsec_like'
    check (mode in ('parsec_like', 'moonlight')),
  route text not null default 'lan_udp'
    check (route in ('lan_udp', 'p2p', 'relay')),
  stream_profile_json text not null default '{}',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at text
);
create index if not exists sessions_host_idx on sessions (host_id, status);

create table if not exists participants (
  id text primary key,
  session_id text not null references sessions(id) on delete cascade,
  device_id text not null references devices(id) on delete cascade,
  role text not null check (role in ('host', 'guest')),
  presence text not null default 'joining'
    check (presence in ('joining', 'pending', 'connected', 'removed')),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique (session_id, device_id)
);
create index if not exists participants_session_idx on participants (session_id);
create index if not exists participants_device_idx on participants (device_id);

create table if not exists permission_sets (
  participant_id text primary key references participants(id) on delete cascade,
  keyboard integer not null default 0 check (keyboard in (0, 1)),
  mouse integer not null default 0 check (mouse in (0, 1)),
  gamepad integer not null default 0 check (gamepad in (0, 1)),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table if not exists moonlight_hosts (
  id text primary key,
  owner_device_id text references devices(id) on delete cascade,
  name text not null,
  address text not null,
  port integer not null default 47989,
  mac_address text not null default '',
  status text not null default 'online'
    check (status in ('online', 'offline', 'busy')),
  paired integer not null default 0 check (paired in (0, 1)),
  pending_pin text,
  server_cert_fingerprint text,
  gpu_model text not null default '',
  host_version text not null default '',
  apps_json text not null default '[]',
  last_seen_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create index if not exists moonlight_hosts_owner_idx on moonlight_hosts (owner_device_id);

create table if not exists friendships (
  id text primary key,
  owner_device_id text not null references devices(id) on delete cascade,
  friend_device_id text references devices(id) on delete set null,
  friend_name text not null,
  friend_tag text not null,
  keyboard integer not null default 0 check (keyboard in (0, 1)),
  mouse integer not null default 0 check (mouse in (0, 1)),
  gamepad integer not null default 1 check (gamepad in (0, 1)),
  auto_connect integer not null default 0 check (auto_connect in (0, 1)),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create index if not exists friendships_owner_idx on friendships (owner_device_id);
