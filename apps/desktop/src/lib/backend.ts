import type { Friendship, Host, Invitation, SessionDetails, StreamProfile } from "@pulselink/protocol";
import { api, clearAuth, loadAuth, saveAuth, type StoredAuth } from "../api";

/**
 * Where hosts, sessions and friends live.
 *  - "cloud": Supabase, used when signed in. Works across networks; no secrets on this PC.
 *  - "local": the signal server bundled with the app. No account needed; same PC / same LAN only.
 */
export interface Backend {
  kind: "local" | "cloud";
  /** This PC's device id in this backend (participants and hosts refer to it). */
  deviceId: string;
  deviceName: string;
  listHosts(): Promise<{ myHosts: Host[]; availableHosts: Host[] }>;
  setHost(input: { name: string; online: boolean; capabilities: Record<string, unknown> }): Promise<Host>;
  /** Keeps an online host marked as reachable (cloud hosts go stale without it). */
  heartbeat(hostId: string): Promise<void>;
  listInvites(hostId: string): Promise<Invitation[]>;
  createInvite(hostId: string): Promise<Invitation>;
  redeem(code: string): Promise<string>;
  connectHost(hostId: string, profile: StreamProfile): Promise<string>;
  /** Pending requests on my host + sessions I take part in. */
  listSessions(): Promise<{ pending: SessionDetails[]; active: SessionDetails[] }>;
  sessionDetails(sessionId: string): Promise<SessionDetails | null>;
  approve(sessionId: string): Promise<void>;
  deny(sessionId: string): Promise<void>;
  end(sessionId: string): Promise<void>;
  setPermissions(sessionId: string, participantId: string, perms: { keyboard: boolean; mouse: boolean }): Promise<void>;
  kick(sessionId: string, participantId: string): Promise<void>;
  listFriends(): Promise<Friendship[]>;
  addFriend(input: string): Promise<Friendship>;
  updateFriend(id: string, patch: Partial<Pick<Friendship, "keyboard" | "mouse" | "autoConnect">>): Promise<Friendship>;
  removeFriend(id: string): Promise<void>;
  renameDevice(name: string): Promise<void>;
  /** Calls `onChange` when something relevant changes server-side. Returns an unsubscribe. */
  subscribe(onChange: () => void): () => void;
  /** Stable id other people use to add you as a friend. */
  friendCode: string;
}

/** Registers (once) this PC with the local signal server and returns its token. */
export async function ensureLocalAuth(name: string): Promise<StoredAuth> {
  const existing = loadAuth();
  if (existing) return existing;
  const registered = await api.register(name);
  const next = { token: registered.token, device: registered.device };
  saveAuth(next);
  return next;
}

export function createLocalBackend(auth: StoredAuth): Backend {
  const t = auth.token;
  return {
    kind: "local",
    deviceId: auth.device.id,
    deviceName: auth.device.displayName,
    friendCode: auth.device.id.slice(0, 8).toUpperCase(),
    listHosts: () => api.listHosts(t),
    async setHost({ name, online, capabilities }) {
      const { myHosts } = await api.listHosts(t);
      const mine = myHosts[0];
      const host = mine ?? (await api.createHost(t, { name, capabilities, mediaEndpoint: null }));
      return api.patchHost(t, host.id, { name, capabilities, status: online ? "online" : "offline" });
    },
    heartbeat: async () => {},
    listInvites: (hostId) => api.listInvitations(t, hostId),
    createInvite: (hostId) => api.createInvitation(t, { hostId, maxUses: 5, expiresInSeconds: 7200 }),
    redeem: async (code) => (await api.redeem(t, code)).session.id,
    connectHost: async (hostId, profile) => (await api.connectHost(t, hostId, profile)).session.id,
    async listSessions() {
      const [pending, active] = await Promise.all([api.pendingDetails(t), api.activeSessions(t)]);
      return { pending, active };
    },
    sessionDetails: (id) => api.sessionDetails(t, id).catch(() => null),
    approve: async (id) => void (await api.approve(t, id)),
    deny: async (id) => void (await api.deny(t, id)),
    end: async (id) => void (await api.end(t, id)),
    setPermissions: async (sid, pid, perms) => void (await api.setPermissions(t, sid, pid, { ...perms, gamepad: false })),
    kick: async (sid, pid) => void (await api.kickParticipant(t, sid, pid)),
    listFriends: () => api.listFriends(t),
    addFriend: (input) => api.addFriend(t, input),
    updateFriend: (id, patch) => api.updateFriend(t, id, patch),
    removeFriend: async (id) => void (await api.deleteFriend(t, id)),
    async renameDevice(name) {
      const d = await api.updateDeviceName(t, name);
      saveAuth({ ...auth, device: d });
    },
    subscribe: () => () => {}, // local mode is driven by the WebSocket in AppState
  };
}

export function resetLocalAuth() {
  clearAuth();
}
