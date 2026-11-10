import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import type {
  Device,
  Friendship,
  Host,
  Invitation,
  Participant,
  ParticipantWithDetails,
  PermissionSet,
  Session,
  SessionDetails,
} from "@pulselink/protocol";

// PULSELINK_ROOT points at the folder holding replica/*.sql when running from the installed app.
const root = process.env.PULSELINK_ROOT || join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const schemaPath = join(root, "replica", "schema.sql");
// PULSELINK_DATA_DIR lets tests (and portable installs) use an isolated database.
const dataDir = process.env.PULSELINK_DATA_DIR || join(root, ".data");
const dbPath = join(dataDir, "signal.sqlite");

export function openDb(): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("pragma foreign_keys = on;");
  db.exec(readFileSync(schemaPath, "utf8"));

  migrate(db);
  return db;
}

function migrate(db: DatabaseSync) {
  const deviceCols = db.prepare(`pragma table_info(devices)`).all() as { name: string }[];
  if (!deviceCols.some((c) => c.name === "user_id")) {
    db.exec(`alter table devices add column user_id text`);
  }
  const sessionCols = db.prepare(`pragma table_info(sessions)`).all() as { name: string }[];
  if (!sessionCols.some((c) => c.name === "session_key")) {
    db.exec(`alter table sessions add column session_key text`);
  }
  // Every new session gets a random 256-bit key unless one was provided (e.g. pulled from the cloud).
  db.exec(`
    create trigger if not exists sessions_session_key
    after insert on sessions
    when new.session_key is null
    begin
      update sessions set session_key = lower(hex(randomblob(32))) where id = new.id;
    end;
  `);
  db.exec(`update sessions set session_key = lower(hex(randomblob(32))) where session_key is null`);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function nowIso(): string {
  return new Date().toISOString();
}

function inviteCode(): string {
  return randomBytes(4).toString("hex").toUpperCase();
}

export type Store = ReturnType<typeof createStore>;

export function createStore(db: DatabaseSync) {
  const registerDevice = (displayName: string): { device: Device; token: string } => {
    const id = randomUUID();
    const token = newToken();
    const createdAt = nowIso();
    const cleanName = displayName.trim() || os.hostname() || "Device";
    const tokenHash = hashToken(token);
    db.prepare(
      `insert into devices (id, display_name, token_hash, created_at, updated_at)
       values (?, ?, ?, ?, ?)`,
    ).run(id, cleanName, tokenHash, createdAt, createdAt);
    const device = { id, displayName: cleanName, createdAt };
    return {
      token,
      device,
    };
  };

  const updateDeviceName = (deviceId: string, displayName: string): Device | null => {
    const cleanName = displayName.trim();
    if (!cleanName) return getDevice(deviceId);
    const updatedAt = nowIso();
    db.prepare(`update devices set display_name = ?, updated_at = ? where id = ?`).run(
      cleanName,
      updatedAt,
      deviceId,
    );
    const row = db
      .prepare(`select token_hash as tokenHash from devices where id = ?`)
      .get(deviceId) as { tokenHash: string } | undefined;
    const updated = getDevice(deviceId);
    if (updated && row) {
    }
    return updated;
  };

  const getDevice = (id: string): Device | null => {
    const row = db
      .prepare(
        `select id, display_name as displayName, created_at as createdAt
         from devices where id = ?`,
      )
      .get(id) as Device | undefined;
    return row ?? null;
  };

  const deviceByToken = (token: string): Device | null => {
    const row = db
      .prepare(
        `select id, display_name as displayName, created_at as createdAt
         from devices where token_hash = ?`,
      )
      .get(hashToken(token)) as Device | undefined;
    return row ?? null;
  };

  const createHost = (
    ownerDeviceId: string,
    name: string,
    capabilities: Record<string, unknown> = {},
    mediaEndpoint: string | null = null,
  ): Host => {
    const cleanName = name.trim() || "Host";
    // One host per owning device. Matching by name used to let anyone take over another
    // user's host by registering the same name, so we only ever match on the owner.
    const existing = db
      .prepare(`select id from hosts where owner_device_id = ? order by updated_at desc limit 1`)
      .get(ownerDeviceId) as { id: string } | undefined;

    const now = nowIso();
    if (existing) {
      db.prepare(
        `update hosts
         set name = ?, status = 'online', capabilities_json = ?, media_endpoint = ?, updated_at = ?
         where id = ?`,
      ).run(
        cleanName,
        JSON.stringify(capabilities),
        mediaEndpoint ?? "127.0.0.1:9000",
        now,
        existing.id,
      );
      const updated = getHost(existing.id)!;
      return updated;
    }

    const id = randomUUID();
    db.prepare(
      `insert into hosts
        (id, owner_device_id, name, status, capabilities_json, media_endpoint, created_at, updated_at)
       values (?, ?, ?, 'online', ?, ?, ?, ?)`,
    ).run(
      id,
      ownerDeviceId,
      cleanName,
      JSON.stringify(capabilities),
      mediaEndpoint ?? "127.0.0.1:9000",
      now,
      now,
    );
    const created = getHost(id)!;
    return created;
  };

  const getHost = (id: string): Host | null => {
    const row = db
      .prepare(
        `select h.id, h.owner_device_id as ownerDeviceId, d.display_name as ownerDisplayName,
                h.name, h.status, h.capabilities_json as capabilitiesJson,
                h.media_endpoint as mediaEndpoint, h.created_at as createdAt, h.updated_at as updatedAt
         from hosts h
         left join devices d on d.id = h.owner_device_id
         where h.id = ?`,
      )
      .get(id) as
      | {
          id: string;
          ownerDeviceId: string;
          ownerDisplayName?: string;
          name: string;
          status: Host["status"];
          capabilitiesJson: string;
          mediaEndpoint: string | null;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      ownerDeviceId: row.ownerDeviceId,
      ownerDisplayName: row.ownerDisplayName,
      name: row.name,
      status: row.status,
      capabilities: JSON.parse(row.capabilitiesJson) as Record<string, unknown>,
      mediaEndpoint: row.mediaEndpoint,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  };

  const listHosts = (deviceId: string): { myHosts: Host[]; availableHosts: Host[] } => {
    // Visible hosts: my own, my friends' (friendships I created), and other devices linked to
    // the same cloud account (my other PCs). Never the whole directory of every user.
    const rows = db
      .prepare(
        `select h.id, h.owner_device_id as ownerDeviceId
         from hosts h
         left join devices owner on owner.id = h.owner_device_id
         left join devices me on me.id = ?
         where h.capabilities_json not like '%"mode":"moonlight"%'
           and (
             h.owner_device_id = me.id
             or h.owner_device_id in (
               select friend_device_id from friendships
               where owner_device_id = me.id and friend_device_id is not null
             )
             or (me.user_id is not null and owner.user_id = me.user_id)
           )
         order by h.updated_at desc`,
      )
      .all(deviceId) as { id: string; ownerDeviceId: string }[];
    const all = rows.map((r) => getHost(r.id)!).filter(Boolean);
    return {
      myHosts: all.filter((h) => h.ownerDeviceId === deviceId),
      availableHosts: all.filter((h) => h.ownerDeviceId !== deviceId),
    };
  };

  const patchHost = (
    id: string,
    patch: Partial<{
      status: Host["status"];
      mediaEndpoint: string | null;
      name: string;
      capabilities: Record<string, unknown>;
    }>,
  ): Host | null => {
    const current = getHost(id);
    if (!current) return null;
    const updatedAt = nowIso();
    db.prepare(
      `update hosts
       set status = ?, media_endpoint = ?, name = ?, capabilities_json = ?, updated_at = ?
       where id = ?`,
    ).run(
      patch.status ?? current.status,
      patch.mediaEndpoint !== undefined ? patch.mediaEndpoint : current.mediaEndpoint,
      patch.name ?? current.name,
      patch.capabilities ? JSON.stringify(patch.capabilities) : JSON.stringify(current.capabilities),
      updatedAt,
      id,
    );
    const updated = getHost(id);
    return updated;
  };

  const createInvitation = (
    hostId: string,
    maxUses = 5,
    expiresInSeconds = 7200,
  ): Invitation => {
    const id = randomUUID();
    const code = inviteCode();
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    db.prepare(
      `insert into invitations (id, host_id, code, max_uses, use_count, expires_at, created_at)
       values (?, ?, ?, ?, 0, ?, ?)`,
    ).run(id, hostId, code, maxUses, expiresAt, createdAt);
    const invite: Invitation = {
      id,
      hostId,
      code,
      maxUses,
      useCount: 0,
      expiresAt,
      createdAt,
    };
    return invite;
  };

  const listInvitationsForHost = (hostId: string): Invitation[] => {
    const rows = db
      .prepare(
        `select id, host_id as hostId, code, max_uses as maxUses, use_count as useCount,
                expires_at as expiresAt, created_at as createdAt
         from invitations
         where host_id = ?
         order by created_at desc limit 10`,
      )
      .all(hostId) as Invitation[];
    return rows;
  };

  const invitationByCode = (code: string): Invitation | null => {
    const row = db
      .prepare(
        `select id, host_id as hostId, code, max_uses as maxUses, use_count as useCount,
                expires_at as expiresAt, created_at as createdAt
         from invitations where upper(code) = upper(?)`,
      )
      .get(code) as Invitation | undefined;
    return row ?? null;
  };

  const getSession = (id: string): Session | null => {
    const row = db
      .prepare(
        `select s.id, s.host_id as hostId, h.name as hostName, s.invitation_id as invitationId,
                s.status, s.mode, s.route, s.stream_profile_json as streamProfileJson,
                s.session_key as sessionKey,
                s.created_at as createdAt, s.updated_at as updatedAt, s.ended_at as endedAt
         from sessions s
         left join hosts h on h.id = s.host_id
         where s.id = ?`,
      )
      .get(id) as
      | {
          id: string;
          hostId: string;
          hostName?: string;
          invitationId: string | null;
          status: Session["status"];
          mode: Session["mode"];
          route: Session["route"];
          streamProfileJson: string;
          sessionKey: string | null;
          createdAt: string;
          updatedAt: string;
          endedAt: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      hostId: row.hostId,
      hostName: row.hostName,
      invitationId: row.invitationId,
      status: row.status,
      mode: row.mode,
      route: row.route,
      streamProfile: JSON.parse(row.streamProfileJson) as Record<string, unknown>,
      sessionKey: row.sessionKey,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      endedAt: row.endedAt,
    };
  };

  const getParticipant = (id: string): Participant | null => {
    const row = db
      .prepare(
        `select p.id, p.session_id as sessionId, p.device_id as deviceId,
                d.display_name as displayName, p.role, p.presence, p.created_at as createdAt
         from participants p
         left join devices d on d.id = p.device_id
         where p.id = ?`,
      )
      .get(id) as Participant | undefined;
    return row ?? null;
  };

  const getPermissions = (participantId: string): PermissionSet | null => {
    const row = db
      .prepare(
        `select participant_id as participantId, keyboard, mouse, gamepad, updated_at as updatedAt
         from permission_sets where participant_id = ?`,
      )
      .get(participantId) as
      | {
          participantId: string;
          keyboard: number;
          mouse: number;
          gamepad: number;
          updatedAt: string;
        }
      | undefined;
    if (!row) return null;
    return {
      participantId: row.participantId,
      keyboard: !!row.keyboard,
      mouse: !!row.mouse,
      gamepad: !!row.gamepad,
      updatedAt: row.updatedAt,
    };
  };

  const getParticipantWithDetails = (participantId: string): ParticipantWithDetails | null => {
    const p = getParticipant(participantId);
    if (!p) return null;
    const perms = getPermissions(participantId) ?? {
      participantId,
      keyboard: false,
      mouse: false,
      gamepad: false,
      updatedAt: p.createdAt,
    };
    return {
      ...p,
      displayName: p.displayName ?? "Device",
      permissions: perms,
    };
  };

  const getSessionDetails = (sessionId: string): SessionDetails | null => {
    const session = getSession(sessionId);
    if (!session) return null;
    const host = getHost(session.hostId);
    const pRows = db
      .prepare(`select id from participants where session_id = ? order by created_at asc`)
      .all(sessionId) as { id: string }[];
    const participants = pRows
      .map((r) => getParticipantWithDetails(r.id)!)
      .filter(Boolean);
    return {
      session,
      host,
      participants,
    };
  };

  const redeemInvitation = (code: string, guestDeviceId: string) => {
    // Also allow connecting by Host ID or Peer ID prefix if not an invite code
    const invite = invitationByCode(code);
    if (!invite) {
      // Peer ID lookup: require a meaningful prefix and treat LIKE wildcards literally,
      // otherwise an empty or "%" code would match an arbitrary host.
      const trimmed = code.trim();
      if (trimmed.length < 6) {
        throw Object.assign(new Error("Invalid share link or Peer ID"), { status: 404 });
      }
      const pattern = `${trimmed.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const hostByPeerPrefix = db
        .prepare(
          `select id from hosts
           where upper(id) like upper(?) escape '\\' or upper(owner_device_id) like upper(?) escape '\\'
           limit 1`,
        )
        .get(pattern, pattern) as { id: string } | undefined;
      if (hostByPeerPrefix) {
        return connectHostDirect(hostByPeerPrefix.id, guestDeviceId, {});
      }
      throw Object.assign(new Error("Invalid share link or Peer ID"), { status: 404 });
    }
    if (invite.useCount >= invite.maxUses) {
      throw Object.assign(new Error("Share link has reached maximum uses"), { status: 410 });
    }
    if (Date.parse(invite.expiresAt) < Date.now()) {
      throw Object.assign(new Error("Share link has expired"), { status: 410 });
    }
    const host = getHost(invite.hostId);
    if (!host) throw Object.assign(new Error("Host not found"), { status: 404 });
    if (host.ownerDeviceId === guestDeviceId) {
      throw Object.assign(
        new Error("Host cannot redeem its own share link (open a Guest Window to test)"),
        { status: 400 },
      );
    }

    const createdAt = nowIso();
    const sessionId = randomUUID();
    const guestParticipantId = randomUUID();
    const hostParticipantId = randomUUID();

    db.exec("begin");
    try {
      db.prepare(
        `update invitations set use_count = use_count + 1 where id = ?`,
      ).run(invite.id);
      db.prepare(
        `insert into sessions
          (id, host_id, invitation_id, status, mode, route, stream_profile_json, created_at, updated_at)
         values (?, ?, ?, 'pending', 'parsec_like', 'lan_udp', '{}', ?, ?)`,
      ).run(sessionId, host.id, invite.id, createdAt, createdAt);
      db.prepare(
        `insert into participants (id, session_id, device_id, role, presence, created_at)
         values (?, ?, ?, 'host', 'connected', ?)`,
      ).run(hostParticipantId, sessionId, host.ownerDeviceId, createdAt);
      db.prepare(
        `insert into participants (id, session_id, device_id, role, presence, created_at)
         values (?, ?, ?, 'guest', 'pending', ?)`,
      ).run(guestParticipantId, sessionId, guestDeviceId, createdAt);
      db.prepare(
        `insert into permission_sets (participant_id, keyboard, mouse, gamepad, updated_at)
         values (?, 0, 0, 0, ?)`,
      ).run(guestParticipantId, createdAt);
      db.prepare(
        `insert into permission_sets (participant_id, keyboard, mouse, gamepad, updated_at)
         values (?, 1, 1, 1, ?)`,
      ).run(hostParticipantId, createdAt);
      db.exec("commit");
    } catch (err) {
      db.exec("rollback");
      throw err;
    }

    const sessionObj = getSession(sessionId)!;
    const guestPerms = getPermissions(guestParticipantId);

    return {
      session: sessionObj,
      participant: getParticipantWithDetails(guestParticipantId)!,
      permissions: guestPerms!,
      host,
    };
  };

  const connectHostDirect = (
    hostId: string,
    deviceId: string,
    streamProfile: Record<string, unknown> = {},
  ) => {
    const host = getHost(hostId);
    if (!host) throw Object.assign(new Error("Host not found"), { status: 404 });
    if (host.status === "offline") {
      throw Object.assign(new Error("Host is currently offline"), { status: 409 });
    }

    const isOwner = host.ownerDeviceId === deviceId;
    // Check if this guest has "Can connect without your approval (careful!)" enabled in friendships
    const friendPerm = db
      .prepare(
        `select auto_connect as autoConnect, keyboard, mouse, gamepad
         from friendships
         where owner_device_id = ? and friend_device_id = ? limit 1`,
      )
      .get(host.ownerDeviceId, deviceId) as
      | { autoConnect: number; keyboard: number; mouse: number; gamepad: number }
      | undefined;

    const autoApproved = isOwner || !!friendPerm?.autoConnect;
    const createdAt = nowIso();
    const sessionId = randomUUID();
    const hostParticipantId = randomUUID();
    const guestParticipantId = randomUUID();

    db.exec("begin");
    try {
      db.prepare(
        `insert into sessions
          (id, host_id, invitation_id, status, mode, route, stream_profile_json, created_at, updated_at)
         values (?, ?, null, ?, 'parsec_like', 'lan_udp', ?, ?, ?)`,
      ).run(
        sessionId,
        host.id,
        autoApproved ? "active" : "pending",
        JSON.stringify(streamProfile),
        createdAt,
        createdAt,
      );
      db.prepare(
        `insert into participants (id, session_id, device_id, role, presence, created_at)
         values (?, ?, ?, 'host', 'connected', ?)`,
      ).run(hostParticipantId, sessionId, host.ownerDeviceId, createdAt);
      db.prepare(
        `insert into permission_sets (participant_id, keyboard, mouse, gamepad, updated_at)
         values (?, 1, 1, 1, ?)`,
      ).run(hostParticipantId, createdAt);

      if (!isOwner) {
        db.prepare(
          `insert into participants (id, session_id, device_id, role, presence, created_at)
           values (?, ?, ?, 'guest', ?, ?)`,
        ).run(
          guestParticipantId,
          sessionId,
          deviceId,
          autoApproved ? "connected" : "pending",
          createdAt,
        );
        db.prepare(
          `insert into permission_sets (participant_id, keyboard, mouse, gamepad, updated_at)
           values (?, ?, ?, ?, ?)`,
        ).run(
          guestParticipantId,
          friendPerm ? friendPerm.keyboard : autoApproved ? 1 : 0,
          friendPerm ? friendPerm.mouse : autoApproved ? 1 : 0,
          friendPerm ? friendPerm.gamepad : 1,
          createdAt,
        );
      }
      db.exec("commit");
    } catch (err) {
      db.exec("rollback");
      throw err;
    }

    const activeParticipantId = isOwner ? hostParticipantId : guestParticipantId;
    const sessionObj = getSession(sessionId)!;

    return {
      session: sessionObj,
      participant: getParticipantWithDetails(activeParticipantId)!,
      permissions: getPermissions(activeParticipantId)!,
      host,
      isOwner: autoApproved,
    };
  };

  const approveSession = (sessionId: string, ownerDeviceId: string) => {
    const session = getSession(sessionId);
    if (!session) throw Object.assign(new Error("Session not found"), { status: 404 });
    const host = getHost(session.hostId);
    if (!host || host.ownerDeviceId !== ownerDeviceId) {
      throw Object.assign(new Error("Only the host owner can approve"), { status: 403 });
    }
    if (session.status !== "pending") {
      throw Object.assign(new Error("Session is not pending"), { status: 409 });
    }
    const updatedAt = nowIso();
    db.prepare(`update sessions set status = 'active', updated_at = ? where id = ?`).run(
      updatedAt,
      sessionId,
    );
    db.prepare(
      `update participants set presence = 'connected'
       where session_id = ? and role = 'guest'`,
    ).run(sessionId);
    const guest = db
      .prepare(
        `select id, device_id as deviceId from participants where session_id = ? and role = 'guest' limit 1`,
      )
      .get(sessionId) as { id: string; deviceId: string } | undefined;
    if (guest) {
      // Remote input is real, so approval alone never grants control: friends get the
      // permissions saved for them, everyone else starts view-only until the host enables input.
      const friend = db
        .prepare(
          `select keyboard, mouse from friendships where owner_device_id = ? and friend_device_id = ? limit 1`,
        )
        .get(ownerDeviceId, guest.deviceId) as { keyboard: number; mouse: number } | undefined;
      db.prepare(
        `update permission_sets set keyboard = ?, mouse = ?, gamepad = 0, updated_at = ? where participant_id = ?`,
      ).run(friend?.keyboard ? 1 : 0, friend?.mouse ? 1 : 0, updatedAt, guest.id);
    }
    const updatedSession = getSession(sessionId)!;
    const updatedPerms = guest ? getPermissions(guest.id) : null;
    return {
      session: updatedSession,
      host: getHost(session.hostId)!,
      permissions: updatedPerms,
    };
  };

  const denySession = (sessionId: string, ownerDeviceId: string) => {
    const session = getSession(sessionId);
    if (!session) throw Object.assign(new Error("Session not found"), { status: 404 });
    const host = getHost(session.hostId);
    if (!host || host.ownerDeviceId !== ownerDeviceId) {
      throw Object.assign(new Error("Only the host owner can reject"), { status: 403 });
    }
    const updatedAt = nowIso();
    db.prepare(
      `update sessions set status = 'denied', updated_at = ?, ended_at = ? where id = ?`,
    ).run(updatedAt, updatedAt, sessionId);
    const updated = getSession(sessionId)!;
    return updated;
  };

  const endSession = (sessionId: string, deviceId: string) => {
    const session = getSession(sessionId);
    if (!session) throw Object.assign(new Error("Session not found"), { status: 404 });
    const member = db
      .prepare(
        `select id from participants where session_id = ? and device_id = ?`,
      )
      .get(sessionId, deviceId);
    const host = getHost(session.hostId);
    if (!member && (!host || host.ownerDeviceId !== deviceId)) {
      throw Object.assign(new Error("Not a participant"), { status: 403 });
    }
    const updatedAt = nowIso();
    db.prepare(
      `update sessions set status = 'ended', updated_at = ?, ended_at = ? where id = ?`,
    ).run(updatedAt, updatedAt, sessionId);
    const updated = getSession(sessionId)!;
    return updated;
  };

  const setPermissions = (
    sessionId: string,
    participantId: string,
    ownerDeviceId: string,
    perms: { keyboard: boolean; mouse: boolean; gamepad: boolean },
  ): PermissionSet => {
    const session = getSession(sessionId);
    if (!session) throw Object.assign(new Error("Session not found"), { status: 404 });
    const host = getHost(session.hostId);
    if (!host || host.ownerDeviceId !== ownerDeviceId) {
      throw Object.assign(new Error("Only the host owner can change permissions"), { status: 403 });
    }
    const participant = getParticipant(participantId);
    if (!participant || participant.sessionId !== sessionId) {
      throw Object.assign(new Error("Invalid participant"), { status: 404 });
    }
    const updatedAt = nowIso();
    db.prepare(
      `update permission_sets set keyboard = ?, mouse = ?, gamepad = ?, updated_at = ?
       where participant_id = ?`,
    ).run(
      perms.keyboard ? 1 : 0,
      perms.mouse ? 1 : 0,
      perms.gamepad ? 1 : 0,
      updatedAt,
      participantId,
    );
    const updated = getPermissions(participantId)!;
    return updated;
  };

  const kickParticipant = (
    sessionId: string,
    participantId: string,
    ownerDeviceId: string,
  ): ParticipantWithDetails => {
    const session = getSession(sessionId);
    if (!session) throw Object.assign(new Error("Session not found"), { status: 404 });
    const host = getHost(session.hostId);
    if (!host || host.ownerDeviceId !== ownerDeviceId) {
      throw Object.assign(new Error("Only the host owner can kick participants"), { status: 403 });
    }
    const participant = getParticipant(participantId);
    if (!participant || participant.sessionId !== sessionId) {
      throw Object.assign(new Error("Invalid participant"), { status: 404 });
    }
    const updatedAt = nowIso();
    db.prepare(`update participants set presence = 'removed' where id = ?`).run(participantId);
    db.prepare(
      `update permission_sets set keyboard = 0, mouse = 0, gamepad = 0, updated_at = ? where participant_id = ?`,
    ).run(updatedAt, participantId);
    return getParticipantWithDetails(participantId)!;
  };

  const listPendingForHost = (ownerDeviceId: string): SessionDetails[] => {
    const rows = db
      .prepare(
        `select s.id from sessions s
         join hosts h on h.id = s.host_id
         where h.owner_device_id = ? and s.status = 'pending'
         order by s.created_at desc`,
      )
      .all(ownerDeviceId) as { id: string }[];
    return rows.map((r) => getSessionDetails(r.id)!).filter(Boolean);
  };

  const listActiveSessionsForDevice = (deviceId: string): SessionDetails[] => {
    const rows = db
      .prepare(
        `select distinct s.id, s.updated_at from sessions s
         left join hosts h on h.id = s.host_id
         left join participants p on p.session_id = s.id
         where s.status in ('active', 'pending')
           and (h.owner_device_id = ? or p.device_id = ?)
         order by s.updated_at desc limit 10`,
      )
      .all(deviceId, deviceId) as { id: string }[];
    return rows.map((r) => getSessionDetails(r.id)!).filter(Boolean);
  };

  const participantDeviceIds = (sessionId: string): string[] => {
    const rows = db
      .prepare(
        `select device_id as deviceId from participants where session_id = ? and presence <> 'removed'`,
      )
      .all(sessionId) as { deviceId: string }[];
    const session = getSession(sessionId);
    const host = session ? getHost(session.hostId) : null;
    const ids = rows.map((r) => r.deviceId);
    if (host && !ids.includes(host.ownerDeviceId)) ids.push(host.ownerDeviceId);
    return ids;
  };

  // --- Real Friendships Store (No Mock Data) ---

  const listFriendships = (ownerDeviceId: string): Friendship[] => {
    const rows = db
      .prepare(
        `select f.id, f.owner_device_id as ownerDeviceId, f.friend_device_id as friendDeviceId,
                f.friend_name as friendName, f.friend_tag as friendTag,
                f.keyboard, f.mouse, f.gamepad, f.auto_connect as autoConnect, f.created_at as createdAt,
                h.status as hostStatus, h.name as hostName
         from friendships f
         left join hosts h on h.owner_device_id = f.friend_device_id
         where f.owner_device_id = ?
         order by f.created_at desc`,
      )
      .all(ownerDeviceId) as {
      id: string;
      ownerDeviceId: string;
      friendDeviceId: string | null;
      friendName: string;
      friendTag: string;
      keyboard: number;
      mouse: number;
      gamepad: number;
      autoConnect: number;
      createdAt: string;
      hostStatus?: string;
      hostName?: string;
    }[];

    return rows.map((r) => ({
      id: r.id,
      ownerDeviceId: r.ownerDeviceId,
      friendDeviceId: r.friendDeviceId,
      friendName: r.friendName,
      friendTag: r.friendTag,
      online: r.hostStatus === "online" || !!r.friendDeviceId,
      statusText:
        r.hostStatus === "online"
          ? `Online · Hosting ${r.hostName ?? "Computer"}`
          : r.friendDeviceId
            ? "Connected Peer on local server"
            : "Added by username / Peer ID",
      keyboard: !!r.keyboard,
      mouse: !!r.mouse,
      gamepad: !!r.gamepad,
      autoConnect: !!r.autoConnect,
      createdAt: r.createdAt,
    }));
  };

  const addFriendship = (ownerDeviceId: string, rawInput: string): Friendship => {
    const clean = rawInput.trim();
    const [namePart, tagPart] = clean.includes("#") ? clean.split("#") : [clean, ""];
    const searchName = (namePart || clean).trim();

    // Try matching a real registered device in SQLite by displayName or id prefix
    const matchedDevice = db
      .prepare(
        `select id, display_name as displayName from devices
         where id != ? and (lower(display_name) = lower(?) or lower(id) like lower(?))
         order by updated_at desc limit 1`,
      )
      .get(ownerDeviceId, searchName, `${ (tagPart || searchName).trim() }%`) as
      | { id: string; displayName: string }
      | undefined;

    const id = randomUUID();
    const createdAt = nowIso();
    const friendName = matchedDevice ? matchedDevice.displayName : searchName;
    const friendTag = tagPart
      ? `#${tagPart}`
      : matchedDevice
        ? `#${matchedDevice.id.slice(0, 4).toUpperCase()}`
        : `#${randomBytes(2).toString("hex").toUpperCase()}`;

    db.prepare(
      `insert into friendships
        (id, owner_device_id, friend_device_id, friend_name, friend_tag, keyboard, mouse, gamepad, auto_connect, created_at)
       values (?, ?, ?, ?, ?, 0, 0, 1, 0, ?)`,
    ).run(id, ownerDeviceId, matchedDevice?.id ?? null, friendName, friendTag, createdAt);

    const created = listFriendships(ownerDeviceId).find((f) => f.id === id)!;
    return created;
  };

  const updateFriendship = (
    ownerDeviceId: string,
    id: string,
    patch: Partial<{
      keyboard: boolean;
      mouse: boolean;
      gamepad: boolean;
      autoConnect: boolean;
    }>,
  ): Friendship | null => {
    const current = listFriendships(ownerDeviceId).find((f) => f.id === id);
    if (!current) return null;
    db.prepare(
      `update friendships
       set keyboard = ?, mouse = ?, gamepad = ?, auto_connect = ?
       where id = ? and owner_device_id = ?`,
    ).run(
      (patch.keyboard ?? current.keyboard) ? 1 : 0,
      (patch.mouse ?? current.mouse) ? 1 : 0,
      (patch.gamepad ?? current.gamepad) ? 1 : 0,
      (patch.autoConnect ?? current.autoConnect) ? 1 : 0,
      id,
      ownerDeviceId,
    );
    const updated = listFriendships(ownerDeviceId).find((f) => f.id === id) ?? null;
    return updated;
  };

  const deleteFriendship = (ownerDeviceId: string, id: string) => {
    db.prepare(`delete from friendships where id = ? and owner_device_id = ?`).run(
      id,
      ownerDeviceId,
    );
  };

  const setDeviceUser = (deviceId: string, userId: string | null) => {
    db.prepare(`update devices set user_id = ? where id = ?`).run(userId, deviceId);
  };

  return {
    setDeviceUser,
    registerDevice,
    updateDeviceName,
    getDevice,
    deviceByToken,
    createHost,
    getHost,
    listHosts,
    patchHost,
    createInvitation,
    listInvitationsForHost,
    redeemInvitation,
    connectHostDirect,
    getSession,
    getSessionDetails,
    approveSession,
    denySession,
    endSession,
    setPermissions,
    kickParticipant,
    getPermissions,
    getParticipant,
    listPendingForHost,
    listActiveSessionsForDevice,
    participantDeviceIds,
    listFriendships,
    addFriendship,
    updateFriendship,
    deleteFriendship,
  };
}
