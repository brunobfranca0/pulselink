/**
 * Cloud backend: talks to Supabase with the anon key + the signed-in user's session only.
 * Row Level Security filters every read; cross-user writes go through the pl_* SQL functions
 * (see supabase/migrations). Nothing on this PC can read other people's data.
 */
import type { Friendship, Host, Invitation, ParticipantWithDetails, Session, SessionDetails } from "@pulselink/protocol";
import { supabase } from "../supabase";
import type { Backend } from "./backend";

/** Hosts that stop sending heartbeats are shown offline after this long. */
const STALE_MS = 90_000;
const HOST_COLS = "id, device_id, user_id, name, status, capabilities, updated_at, profiles(username)";

type HostRow = {
  id: string;
  device_id: string;
  user_id: string;
  name: string;
  status: Host["status"];
  capabilities: Record<string, unknown>;
  updated_at: string;
  profiles: { username: string } | null;
};

type ParticipantRow = {
  id: string;
  session_id: string;
  user_id: string;
  device_id: string;
  role: "host" | "guest";
  presence: "pending" | "connected" | "removed";
  keyboard: boolean;
  mouse: boolean;
  created_at: string;
  profiles: { username: string } | null;
};

type SessionRow = {
  id: string;
  host_id: string;
  host_user_id: string;
  status: Session["status"];
  session_key: string;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
  pl_hosts: HostRow | null;
  pl_participants: ParticipantRow[];
};

function check<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

function toHost(r: HostRow): Host {
  const stale = Date.now() - Date.parse(r.updated_at) > STALE_MS;
  return {
    id: r.id,
    ownerDeviceId: r.device_id,
    ownerDisplayName: r.profiles?.username,
    name: r.name,
    status: r.status === "online" && stale ? "offline" : r.status,
    capabilities: r.capabilities ?? {},
    mediaEndpoint: null,
    createdAt: r.updated_at,
    updatedAt: r.updated_at,
  };
}

function toDetails(r: SessionRow): SessionDetails {
  const session: Session = {
    id: r.id,
    hostId: r.host_id,
    hostName: r.pl_hosts?.name,
    invitationId: null,
    status: r.status,
    mode: "parsec_like",
    route: "p2p",
    streamProfile: {},
    sessionKey: r.session_key,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    endedAt: r.ended_at,
  };
  const participants: ParticipantWithDetails[] = (r.pl_participants ?? []).map((p) => ({
    id: p.id,
    sessionId: p.session_id,
    deviceId: p.device_id,
    displayName: p.profiles?.username ?? "Convidado",
    role: p.role,
    presence: p.presence,
    createdAt: p.created_at,
    permissions: { participantId: p.id, keyboard: p.keyboard, mouse: p.mouse, gamepad: false, updatedAt: p.created_at },
  }));
  return { session, host: r.pl_hosts ? toHost(r.pl_hosts) : null, participants };
}

const SESSION_COLS = `id, host_id, host_user_id, status, session_key, created_at, updated_at, ended_at,
  pl_hosts(${HOST_COLS}),
  pl_participants(id, session_id, user_id, device_id, role, presence, keyboard, mouse, created_at, profiles(username))`;

/** Finds or registers this PC as a device of the signed-in user. */
async function ensureDevice(userId: string, name: string): Promise<{ id: string; name: string }> {
  const key = `pulselink.cloudDevice.${userId}`;
  const known = localStorage.getItem(key);
  if (known) {
    const found = check(await supabase.from("pl_devices").select("id, name").eq("id", known).maybeSingle()) as {
      id: string;
      name: string;
    } | null;
    if (found) {
      void supabase.from("pl_devices").update({ last_seen_at: new Date().toISOString() }).eq("id", known);
      return found;
    }
  }
  const created = check(
    await supabase.from("pl_devices").insert({ name: name.slice(0, 64) || "PC" }).select("id, name").single(),
  ) as { id: string; name: string };
  localStorage.setItem(key, created.id);
  return created;
}

export async function createCloudBackend(userId: string, preferredName: string): Promise<Backend> {
  const device = await ensureDevice(userId, preferredName);

  const loadSessions = async (ids?: string[]) => {
    let q = supabase.from("pl_sessions").select(SESSION_COLS).in("status", ["pending", "active"]);
    if (ids) q = q.in("id", ids);
    else q = q.gte("created_at", new Date(Date.now() - 12 * 3600_000).toISOString());
    return (check(await q.order("created_at", { ascending: false })) as unknown as SessionRow[]).map(toDetails);
  };

  const backend: Backend = {
    kind: "cloud",
    deviceId: device.id,
    deviceName: device.name,
    friendCode: device.id.slice(0, 8).toUpperCase(),

    async listHosts() {
      const rows = check(await supabase.from("pl_hosts").select(HOST_COLS)) as unknown as HostRow[];
      const hosts = rows.map(toHost);
      return {
        myHosts: hosts.filter((h) => h.ownerDeviceId === device.id),
        availableHosts: hosts.filter((h) => h.ownerDeviceId !== device.id),
      };
    },

    async setHost({ name, online, capabilities }) {
      const fields = {
        name: name.slice(0, 64) || "PC",
        status: online ? "online" : "offline",
        capabilities,
        updated_at: new Date().toISOString(),
      };
      const existing = check(await supabase.from("pl_hosts").select("id").eq("device_id", device.id).maybeSingle()) as {
        id: string;
      } | null;
      const res = existing
        ? await supabase.from("pl_hosts").update(fields).eq("id", existing.id).select(HOST_COLS).single()
        : await supabase.from("pl_hosts").insert({ ...fields, device_id: device.id }).select(HOST_COLS).single();
      return toHost(check(res) as unknown as HostRow);
    },

    async heartbeat(hostId) {
      await supabase.from("pl_hosts").update({ updated_at: new Date().toISOString() }).eq("id", hostId);
    },

    async listInvites(hostId) {
      const rows = check(
        await supabase.from("pl_invites").select("*").eq("host_id", hostId).order("created_at", { ascending: false }),
      ) as { code: string; host_id: string; max_uses: number; use_count: number; expires_at: string; created_at: string }[];
      return rows.map((r) => ({
        id: r.code,
        hostId: r.host_id,
        code: r.code,
        maxUses: r.max_uses,
        useCount: r.use_count,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
      }));
    },

    async createInvite(hostId) {
      const r = check(
        await supabase.rpc("pl_create_invite", { p_host_id: hostId, p_max_uses: 5, p_ttl_seconds: 7200 }).single(),
      ) as { code: string; host_id: string; max_uses: number; use_count: number; expires_at: string; created_at: string };
      const inv: Invitation = {
        id: r.code,
        hostId: r.host_id,
        code: r.code,
        maxUses: r.max_uses,
        useCount: r.use_count,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
      };
      return inv;
    },

    redeem: async (code) =>
      check(await supabase.rpc("pl_redeem_invite", { p_code: code.trim(), p_device_id: device.id })) as string,

    connectHost: async (hostId) =>
      check(await supabase.rpc("pl_connect_host", { p_host_id: hostId, p_device_id: device.id })) as string,

    async listSessions() {
      const all = await loadSessions();
      const pending: SessionDetails[] = [];
      const active: SessionDetails[] = [];
      for (const d of all) {
        const iAmHost = d.host?.ownerDeviceId === device.id;
        const me = d.participants.find((p) => p.deviceId === device.id);
        if (d.session.status === "pending" && iAmHost) pending.push(d);
        else if (me && me.presence !== "removed") active.push(d);
      }
      return { pending, active };
    },

    async sessionDetails(id) {
      return (await loadSessions([id]))[0] ?? null;
    },

    approve: async (id) => void check(await supabase.rpc("pl_approve_session", { p_session_id: id })),
    deny: async (id) => void check(await supabase.rpc("pl_deny_session", { p_session_id: id })),
    end: async (id) => void check(await supabase.rpc("pl_end_session", { p_session_id: id })),
    setPermissions: async (_sid, pid, perms) =>
      void check(
        await supabase.rpc("pl_set_permissions", { p_participant_id: pid, p_keyboard: perms.keyboard, p_mouse: perms.mouse }),
      ),
    kick: async (_sid, pid) => void check(await supabase.rpc("pl_kick", { p_participant_id: pid })),

    async listFriends() {
      const rows = check(
        await supabase
          .from("pl_friends")
          .select("id, friend_id, keyboard, mouse, auto_connect, created_at, friend:profiles!pl_friends_friend_id_fkey(username, discriminator)")
          .order("created_at", { ascending: false }),
      ) as unknown as {
        id: string;
        friend_id: string;
        keyboard: boolean;
        mouse: boolean;
        auto_connect: boolean;
        created_at: string;
        friend: { username: string; discriminator: string } | null;
      }[];
      return rows.map(
        (r): Friendship => ({
          id: r.id,
          ownerDeviceId: device.id,
          friendDeviceId: null,
          friendName: r.friend?.username ?? "?",
          friendTag: r.friend ? `#${r.friend.discriminator}` : "",
          online: false,
          statusText: "Vê seus computadores",
          keyboard: r.keyboard,
          mouse: r.mouse,
          gamepad: false,
          autoConnect: r.auto_connect,
          createdAt: r.created_at,
        }),
      );
    },

    async addFriend(input) {
      check(await supabase.rpc("pl_add_friend", { p_input: input }));
      const list = await backend.listFriends();
      return list[0]!;
    },

    async updateFriend(id, patch) {
      const fields: Record<string, boolean> = {};
      if (patch.keyboard !== undefined) fields.keyboard = patch.keyboard;
      if (patch.mouse !== undefined) fields.mouse = patch.mouse;
      if (patch.autoConnect !== undefined) fields.auto_connect = patch.autoConnect;
      check(await supabase.from("pl_friends").update(fields).eq("id", id));
      return (await backend.listFriends()).find((f) => f.id === id)!;
    },

    removeFriend: async (id) => void check(await supabase.from("pl_friends").delete().eq("id", id)),

    async renameDevice(name) {
      check(await supabase.from("pl_devices").update({ name }).eq("id", device.id));
      check(await supabase.from("pl_hosts").update({ name }).eq("device_id", device.id));
    },

    subscribe(onChange) {
      // RLS applies to change events too, so we only hear about our own rows.
      const ch = supabase.channel(`pl-db-${device.id}`);
      for (const table of ["pl_sessions", "pl_participants", "pl_hosts"]) {
        ch.on("postgres_changes", { event: "*", schema: "public", table }, () => onChange());
      }
      ch.subscribe();
      return () => void supabase.removeChannel(ch);
    },
  };
  return backend;
}
