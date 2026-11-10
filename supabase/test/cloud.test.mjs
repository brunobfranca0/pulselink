// Runs the cloud migration on PGlite (real Postgres in WASM) with a minimal stand-in for
// Supabase's auth/realtime schemas, then checks RLS and RPC rules as three different users.
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(process.env.PL_MIGRATION ?? join(here, "..", "migrations", "0001_pulselink_cloud.sql"), "utf8");

const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create schema realtime;
  create table realtime.messages (id bigserial primary key, topic text, payload jsonb);
  alter table realtime.messages enable row level security;
  create function realtime.topic() returns text language sql stable as
    $$ select current_setting('realtime.topic', true) $$;
  create publication supabase_realtime;
  grant usage on schema public, auth, realtime to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  grant execute on function realtime.topic() to anon, authenticated;
  grant select, insert on realtime.messages to authenticated;
  grant usage on sequence realtime.messages_id_seq to authenticated;
  -- Supabase grants everything in public to these roles by default; RLS does the filtering.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

const U = {
  ana: "00000000-0000-4000-8000-00000000000a",
  bia: "00000000-0000-4000-8000-00000000000b",
  eve: "00000000-0000-4000-8000-00000000000e",
};

let db;

/** Runs `sql` as a signed-in user (or anon when user is null) and returns rows. */
async function as(user, sql, params = []) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user ?? ""]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.exec("reset role");
  }
}

const rejects = (p, re) => assert.rejects(p, re);

describe("PulseLink cloud schema", () => {
  const state = {};

  before(async () => {
    db = new PGlite({ extensions: { pgcrypto } });
    await db.exec(SUPABASE_STUB);
    await db.exec(migration);
    await db.exec(migration); // idempotent
    for (const [name, id] of Object.entries(U)) {
      await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [
        id,
        `${name}@example.com`,
        JSON.stringify({ username: name }),
      ]);
    }
    for (const name of Object.keys(U)) {
      state[`${name}Device`] = (await as(U[name], `insert into pl_devices (name) values ($1) returning id`, [`PC-${name}`]))[0].id;
    }
    state.anaHost = (
      await as(U.ana, `insert into pl_hosts (device_id, name, status) values ($1, 'PC da Ana', 'online') returning id`, [
        state.anaDevice,
      ])
    )[0].id;
  });

  test("signup trigger creates profiles; emails are private", async () => {
    const rows = await as(U.bia, `select username from profiles order by username`);
    assert.deepEqual(rows.map((r) => r.username), ["ana", "bia", "eve"]);
    await rejects(as(U.bia, `select email from profiles`), /permission denied/);
    await rejects(as(null, `select username from profiles`), /permission denied/);
  });

  test("anonymous callers get nothing", async () => {
    await rejects(as(null, `select * from pl_hosts`), /permission denied/);
    await rejects(as(null, `select pl_redeem_invite('X', $1)`, [state.eveDevice]), /permission denied/);
  });

  test("hosts are invisible to strangers; devices cannot be borrowed", async () => {
    assert.equal((await as(U.eve, `select * from pl_hosts`)).length, 0);
    await rejects(
      as(U.eve, `insert into pl_hosts (device_id, name) values ($1, 'roubado')`, [state.anaDevice]),
      /row-level security/,
    );
    await rejects(as(U.eve, `update pl_hosts set user_id = $1`, [U.eve]), /permission denied/);
  });

  test("invites: only the host owner creates and reads them", async () => {
    await rejects(as(U.eve, `select * from pl_create_invite($1)`, [state.anaHost]), /Host não encontrado/);
    const inv = (await as(U.ana, `select * from pl_create_invite($1, 2, 3600)`, [state.anaHost]))[0];
    assert.match(inv.code, /^[0-9A-F]{10}$/);
    state.code = inv.code;
    assert.equal((await as(U.eve, `select * from pl_invites`)).length, 0);
    assert.equal((await as(U.ana, `select * from pl_invites`)).length, 1);
  });

  test("redeem: pending session, view-only guest, key only for members", async () => {
    await rejects(
      as(U.bia, `select pl_redeem_invite($1, $2)`, [state.code, state.anaDevice]),
      /Dispositivo inválido/,
    );
    state.session = (await as(U.bia, `select pl_redeem_invite($1, $2) as id`, [state.code.toLowerCase(), state.biaDevice]))[0].id;
    const s = (await as(U.bia, `select status, session_key from pl_sessions where id = $1`, [state.session]))[0];
    assert.equal(s.status, "pending");
    assert.match(s.session_key, /^[0-9a-f]{64}$/);
    assert.equal((await as(U.eve, `select * from pl_sessions`)).length, 0);
    assert.equal((await as(U.eve, `select * from pl_participants`)).length, 0);
    await rejects(as(U.bia, `update pl_sessions set status = 'active'`), /permission denied/);
  });

  test("invite use limit is enforced", async () => {
    await as(U.eve, `select pl_redeem_invite($1, $2)`, [state.code, state.eveDevice]); // 2nd and last use
    await rejects(as(U.eve, `select pl_redeem_invite($1, $2)`, [state.code, state.eveDevice]), /inválido ou expirado/);
  });

  test("only the host approves and grants control", async () => {
    await rejects(as(U.bia, `select pl_approve_session($1)`, [state.session]), /Somente o host/);
    await as(U.ana, `select pl_approve_session($1)`, [state.session]);
    const guest = (
      await as(U.ana, `select id, presence, keyboard, mouse from pl_participants where session_id = $1 and role = 'guest'`, [
        state.session,
      ])
    )[0];
    assert.deepEqual([guest.presence, guest.keyboard, guest.mouse], ["connected", false, false]);
    state.biaParticipant = guest.id;
    await rejects(as(U.bia, `select pl_set_permissions($1, true, true)`, [guest.id]), /Somente o host/);
    await as(U.ana, `select pl_set_permissions($1, true, false)`, [guest.id]);
    const p = (await as(U.bia, `select keyboard, mouse from pl_participants where id = $1`, [guest.id]))[0];
    assert.deepEqual([p.keyboard, p.mouse], [true, false]);
  });

  test("realtime private channel: members only", async () => {
    const topic = `pl:${state.session}`;
    const sendAs = async (user) => {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user]);
      await db.query("select set_config('realtime.topic', $1, false)", [topic]);
      await db.exec("set role authenticated");
      try {
        await db.query(`insert into realtime.messages (topic, payload) values ($1, '{}')`, [topic]);
      } finally {
        await db.exec("reset role");
      }
    };
    await sendAs(U.bia);
    await rejects(sendAs(U.eve), /row-level security/);
    await db.query("select set_config('realtime.topic', $1, false)", [topic]);
    assert.equal((await as(U.eve, `select * from realtime.messages`)).length, 0);
    assert.equal((await as(U.ana, `select * from realtime.messages`)).length, 1);
  });

  test("kicked guests lose access to the session", async () => {
    await as(U.ana, `select pl_kick($1)`, [state.biaParticipant]);
    assert.equal((await as(U.bia, `select * from pl_sessions where id = $1`, [state.session])).length, 0);
  });

  test("friends: see the owner's computer and use saved permissions", async () => {
    await rejects(as(U.ana, `select pl_add_friend('ninguem#0000')`), /não encontrado/);
    const tag = (await as(U.ana, `select discriminator from profiles where username = 'bia'`))[0].discriminator;
    await as(U.ana, `select pl_add_friend($1)`, [`bia#${tag}`]);
    assert.equal((await as(U.bia, `select * from pl_hosts`)).length, 1, "bia sees ana's host");
    assert.equal((await as(U.eve, `select * from pl_hosts`)).length, 0, "eve still doesn't");
    assert.equal((await as(U.bia, `select * from pl_friends`)).length, 0, "friend rows are private to owner");
    await as(U.ana, `update pl_friends set auto_connect = true, keyboard = true, mouse = true`);
    await rejects(as(U.ana, `update pl_friends set friend_id = $1`, [U.eve]), /permission denied/);

    const sid = (await as(U.bia, `select pl_connect_host($1, $2) as id`, [state.anaHost, state.biaDevice]))[0].id;
    const s = (await as(U.bia, `select status from pl_sessions where id = $1`, [sid]))[0];
    assert.equal(s.status, "active", "auto-connect friend skips approval");
    const g = (await as(U.bia, `select keyboard, mouse from pl_participants where session_id = $1 and role = 'guest'`, [sid]))[0];
    assert.deepEqual([g.keyboard, g.mouse], [true, true]);
    await rejects(as(U.eve, `select pl_connect_host($1, $2)`, [state.anaHost, state.eveDevice]), /não encontrado/);
  });

  test("offline or stale hosts refuse connections", async () => {
    await as(U.ana, `update pl_hosts set updated_at = now() - interval '10 minutes'`);
    await rejects(as(U.bia, `select pl_connect_host($1, $2)`, [state.anaHost, state.biaDevice]), /offline/);
  });
});
