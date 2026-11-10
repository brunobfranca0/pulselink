import {
  DEFAULT_SIGNAL_URL,
  DEFAULT_STREAM_PROFILE,
  type CreateHostRequest,
  type CreateInvitationRequest,
  type Device,
  type Friendship,
  type Host,
  type Invitation,
  type MoonlightClientInfo,
  type MoonlightHost,
  type PlayStationClientInfo,
  type PlayStationConsole,
  type ParticipantWithDetails,
  type PermissionSet,
  type RedeemInvitationResponse,
  type RegisterDeviceResponse,
  type Session,
  type SessionDetails,
  type SetPermissionsRequest,
  type StreamProfile,
  type WsClientMessage,
  type WsServerMessage,
} from "@pulselink/protocol";

const STORAGE_KEY = "pulselink.device";
const PROFILE_KEY = "pulselink.streamProfile";
const SIGNAL_URL_KEY = "pulselink.signalUrl";

export type StoredAuth = { token: string; device: Device };

export type CaptureSourceInfo = {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnailDataUrl: string;
};

export type DisplayInfo = {
  id: string;
  displayId: string;
  name: string;
  width: number;
  height: number;
  refreshRate: number;
  scaleFactor: number;
  isPrimary: boolean;
};

export type SystemHardwareInfo = {
  hostname: string;
  platform: string;
  cpuModel: string;
  cpuCores: number;
  totalMemGb: number;
  lanIp: string;
  physicalDisplaysCount?: number;
  inputInjectionSupported?: boolean;
};

export interface PulseLinkDesktopBridge {
  isDesktopApp: boolean;
  minimize: () => Promise<void>;
  maximizeOrRestore: () => Promise<boolean>;
  close: () => Promise<void>;
  toggleFullScreen: () => Promise<boolean>;
  isMaximized: () => Promise<boolean>;
  openGuestWindow: () => Promise<{ ok: boolean }>;
  getSystemInfo: () => Promise<SystemHardwareInfo>;
  getDisplays: () => Promise<DisplayInfo[]>;
  getCaptureSources: () => Promise<CaptureSourceInfo[]>;
  selectCaptureSource: (sourceId: string) => Promise<{ ok: boolean }>;
  setRemoteInputEnabled: (enabled: boolean) => Promise<{ enabled: boolean; supported: boolean }>;
  injectInput: (payload: import("@pulselink/protocol").RemoteInputPayload) => void;
  openExternal: (url: string) => Promise<boolean>;
  onWindowStateChange: (
    cb: (state: { isMaximized: boolean; isFullScreen: boolean }) => void,
  ) => () => void;
}

declare global {
  interface Window {
    pulselinkDesktop?: PulseLinkDesktopBridge;
  }
}

export function getSignalUrl(): string {
  return localStorage.getItem(SIGNAL_URL_KEY) || DEFAULT_SIGNAL_URL;
}

export function setSignalUrl(url: string) {
  localStorage.setItem(SIGNAL_URL_KEY, url.replace(/\/+$/, "") || DEFAULT_SIGNAL_URL);
}

export function loadAuth(): StoredAuth | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredAuth;
  } catch {
    return null;
  }
}

export function saveAuth(auth: StoredAuth) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
}

export function clearAuth() {
  localStorage.removeItem(STORAGE_KEY);
}

export function loadStreamProfile(): StreamProfile {
  const raw = localStorage.getItem(PROFILE_KEY);
  if (!raw) return DEFAULT_STREAM_PROFILE;
  try {
    return { ...DEFAULT_STREAM_PROFILE, ...(JSON.parse(raw) as Partial<StreamProfile>) };
  } catch {
    return DEFAULT_STREAM_PROFILE;
  }
}

export function saveStreamProfile(profile: StreamProfile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

async function request<T>(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  const res = await fetch(`${getSignalUrl()}${path}`, { ...init, headers });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export const api = {
  health: () => request<{ ok: boolean; service?: string; version?: string }>("/health"),
  register: (displayName: string) =>
    request<RegisterDeviceResponse>("/v1/devices", {
      method: "POST",
      body: JSON.stringify({ displayName }),
    }),
  updateDeviceName: (token: string, displayName: string) =>
    request<Device>("/v1/devices/me", {
      method: "PATCH",
      token,
      body: JSON.stringify({ displayName }),
    }),
  listHosts: (token: string) =>
    request<{ myHosts: Host[]; availableHosts: Host[] }>("/v1/hosts", { token }),
  createHost: (token: string, body: CreateHostRequest) =>
    request<Host>("/v1/hosts", {
      method: "POST",
      token,
      body: JSON.stringify(body),
    }),
  patchHost: (
    token: string,
    id: string,
    body: Partial<{
      status: Host["status"];
      mediaEndpoint: string | null;
      name: string;
      capabilities: Record<string, unknown>;
    }>,
  ) =>
    request<Host>(`/v1/hosts/${id}`, {
      method: "PATCH",
      token,
      body: JSON.stringify(body),
    }),
  connectHost: (token: string, hostId: string, streamProfile: StreamProfile) =>
    request<{
      session: Session;
      participant: ParticipantWithDetails;
      permissions: PermissionSet;
      host: Host;
      isOwner: boolean;
    }>(`/v1/hosts/${hostId}/connect`, {
      method: "POST",
      token,
      body: JSON.stringify({ streamProfile }),
    }),
  listInvitations: (token: string, hostId: string) =>
    request<Invitation[]>(`/v1/invitations?hostId=${encodeURIComponent(hostId)}`, { token }),
  createInvitation: (token: string, body: CreateInvitationRequest) =>
    request<Invitation>("/v1/invitations", {
      method: "POST",
      token,
      body: JSON.stringify(body),
    }),
  redeem: (token: string, code: string) =>
    request<RedeemInvitationResponse>(`/v1/invitations/${encodeURIComponent(code)}/redeem`, {
      method: "POST",
      token,
      body: "{}",
    }),
  pending: (token: string) => request<Session[]>("/v1/sessions/pending", { token }),
  pendingDetails: (token: string) =>
    request<SessionDetails[]>("/v1/sessions/pending-details", { token }),
  activeSessions: (token: string) =>
    request<SessionDetails[]>("/v1/sessions/active", { token }),
  sessionDetails: (token: string, sessionId: string) =>
    request<SessionDetails>(`/v1/sessions/${sessionId}/details`, { token }),
  approve: (token: string, sessionId: string) =>
    request<Session>(`/v1/sessions/${sessionId}/approve`, { method: "POST", token, body: "{}" }),
  deny: (token: string, sessionId: string) =>
    request<Session>(`/v1/sessions/${sessionId}/deny`, { method: "POST", token, body: "{}" }),
  end: (token: string, sessionId: string) =>
    request<Session>(`/v1/sessions/${sessionId}/end`, { method: "POST", token, body: "{}" }),
  setPermissions: (
    token: string,
    sessionId: string,
    participantId: string,
    body: SetPermissionsRequest,
  ) =>
    request<PermissionSet>(
      `/v1/sessions/${sessionId}/participants/${participantId}/permissions`,
      { method: "PUT", token, body: JSON.stringify(body) },
    ),
  kickParticipant: (token: string, sessionId: string, participantId: string) =>
    request<ParticipantWithDetails>(
      `/v1/sessions/${sessionId}/participants/${participantId}/kick`,
      { method: "POST", token, body: "{}" },
    ),
  // Real Friends endpoints (/v1/friends)
  listFriends: (token: string) => request<Friendship[]>("/v1/friends", { token }),
  addFriend: (token: string, friendInput: string) =>
    request<Friendship>("/v1/friends", {
      method: "POST",
      token,
      body: JSON.stringify({ friendInput }),
    }),
  updateFriend: (
    token: string,
    id: string,
    patch: Partial<{
      keyboard: boolean;
      mouse: boolean;
      gamepad: boolean;
      autoConnect: boolean;
    }>,
  ) =>
    request<Friendship>(`/v1/friends/${id}`, {
      method: "PATCH",
      token,
      body: JSON.stringify(patch),
    }),
  deleteFriend: (token: string, id: string) =>
    request<{ ok: boolean }>(`/v1/friends/${id}`, {
      method: "DELETE",
      token,
    }),
  // Moonlight (drives the official Moonlight client through the local signal service)
  moonlightClient: (token: string) =>
    request<MoonlightClientInfo>("/v1/moonlight/client", { token }),
  listMoonlightHosts: (token: string) =>
    request<MoonlightHost[]>("/v1/moonlight/hosts", { token }),
  getMoonlightHost: (token: string, id: string) =>
    request<MoonlightHost>(`/v1/moonlight/hosts/${id}`, { token }),
  scanMoonlightLan: (token: string) =>
    request<MoonlightHost[]>("/v1/moonlight/scan", { method: "POST", token, body: "{}" }),
  addMoonlightHost: (token: string, body: { name?: string; address: string; port?: number }) =>
    request<MoonlightHost>("/v1/moonlight/hosts", { method: "POST", token, body: JSON.stringify(body) }),
  pairMoonlightHost: (token: string, id: string) =>
    request<MoonlightHost>(`/v1/moonlight/hosts/${id}/pair`, { method: "POST", token, body: "{}" }),
  cancelMoonlightPairing: (token: string, id: string) =>
    request<MoonlightHost>(`/v1/moonlight/hosts/${id}/pair-cancel`, { method: "POST", token, body: "{}" }),
  unpairMoonlightHost: (token: string, id: string) =>
    request<MoonlightHost>(`/v1/moonlight/hosts/${id}/unpair`, { method: "POST", token, body: "{}" }),
  refreshMoonlightApps: (token: string, id: string) =>
    request<MoonlightHost>(`/v1/moonlight/hosts/${id}/apps`, { method: "POST", token, body: "{}" }),
  wakeMoonlightHost: (token: string, id: string) =>
    request<MoonlightHost>(`/v1/moonlight/hosts/${id}/wake`, { method: "POST", token, body: "{}" }),
  launchMoonlightApp: (token: string, id: string, appTitle: string, streamProfile: StreamProfile) =>
    request<MoonlightHost>(`/v1/moonlight/hosts/${id}/launch`, {
      method: "POST",
      token,
      body: JSON.stringify({ appTitle, streamProfile }),
    }),
  // PlayStation Remote Play (drives chiaki-ng)
  playstationClient: (token: string) =>
    request<PlayStationClientInfo>("/v1/playstation/client", { token }),
  discoverPlayStations: (token: string, addresses: string[]) =>
    request<PlayStationConsole[]>("/v1/playstation/discover", {
      method: "POST",
      token,
      body: JSON.stringify({ addresses }),
    }),
  launchPlayStation: (token: string, nickname: string, address: string, fullscreen: boolean) =>
    request<{ ok: true }>("/v1/playstation/launch", {
      method: "POST",
      token,
      body: JSON.stringify({ nickname, address, fullscreen }),
    }),
  openChiaki: (token: string) =>
    request<{ ok: true }>("/v1/playstation/open-client", { method: "POST", token, body: "{}" }),
  deleteMoonlightHost: (token: string, id: string) =>
    request<{ ok: boolean }>(`/v1/moonlight/hosts/${id}`, { method: "DELETE", token }),
};

export function connectWs(
  token: string,
  onMessage: (msg: WsServerMessage) => void,
): WebSocket {
  const wsUrl =
    getSignalUrl().replace(/^http/, "ws") + `/v1/ws?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(wsUrl);
  ws.addEventListener("message", (ev) => {
    try {
      onMessage(JSON.parse(String(ev.data)) as WsServerMessage);
    } catch {
      /* ignore */
    }
  });
  return ws;
}

export function wsSend(ws: WebSocket | null, msg: WsClientMessage) {
  if (!ws) return;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else if (ws.readyState === WebSocket.CONNECTING) {
    ws.addEventListener("open", () => ws.send(JSON.stringify(msg)), { once: true });
  }
}

export function wsSubscribe(ws: WebSocket, sessionId: string) {
  wsSend(ws, { type: "subscribe", sessionId });
}
