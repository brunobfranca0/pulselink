export type Device = {
  id: string;
  displayName: string;
  createdAt: string;
};

export type HostStatus = "offline" | "online" | "busy";

/** Codec preference. "auto" lets the browser/WebRTC stack negotiate. */
export type VideoCodec = "auto" | "h264" | "vp9" | "av1" | "hevc";

/**
 * Only settings that are actually applied by the streaming pipeline:
 * - resolution/fps → capture constraints on the host
 * - bitrateMbps   → RTCRtpSender maxBitrate on the host
 * - codec         → RTCRtpTransceiver.setCodecPreferences (falls back if unsupported)
 * - audio         → capture system audio together with the screen
 * The same values are passed as CLI flags when launching the Moonlight client.
 */
export type StreamProfile = {
  resolution: "1280x720" | "1920x1080" | "2560x1440" | "3840x2160";
  fps: 30 | 60 | 120 | 144;
  bitrateMbps: number;
  codec: VideoCodec;
  audio: boolean;
};

export const DEFAULT_STREAM_PROFILE: StreamProfile = {
  resolution: "1920x1080",
  fps: 60,
  bitrateMbps: 20,
  codec: "auto",
  audio: true,
};

export type Friendship = {
  id: string;
  ownerDeviceId: string;
  friendDeviceId: string | null;
  friendName: string;
  friendTag: string;
  online: boolean;
  statusText: string;
  keyboard: boolean;
  mouse: boolean;
  gamepad: boolean;
  autoConnect: boolean;
  createdAt: string;
};

export type Host = {
  id: string;
  ownerDeviceId: string;
  ownerDisplayName?: string;
  name: string;
  status: HostStatus;
  capabilities: Record<string, unknown>;
  mediaEndpoint: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Invitation = {
  id: string;
  hostId: string;
  code: string;
  maxUses: number;
  useCount: number;
  expiresAt: string;
  createdAt: string;
};

export type SessionStatus = "pending" | "active" | "denied" | "ended";
export type SessionRoute = "lan_udp" | "p2p" | "relay";
export type SessionMode = "parsec_like" | "moonlight";

export type Session = {
  id: string;
  hostId: string;
  hostName?: string;
  invitationId: string | null;
  status: SessionStatus;
  mode: SessionMode;
  route: SessionRoute;
  streamProfile: Record<string, unknown>;
  /**
   * 256-bit hex key shared only with session members. Used to encrypt and authenticate
   * WebRTC signaling that travels over the public Supabase Realtime channel.
   */
  sessionKey?: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
};

export type ParticipantRole = "host" | "guest";
export type ParticipantPresence = "joining" | "pending" | "connected" | "removed";

export type Participant = {
  id: string;
  sessionId: string;
  deviceId: string;
  displayName?: string;
  role: ParticipantRole;
  presence: ParticipantPresence;
  createdAt: string;
};

export type PermissionSet = {
  participantId: string;
  keyboard: boolean;
  mouse: boolean;
  gamepad: boolean;
  updatedAt: string;
};

export type ParticipantWithDetails = Participant & {
  displayName: string;
  permissions: PermissionSet;
};

export type SessionDetails = {
  session: Session;
  host: Host | null;
  participants: ParticipantWithDetails[];
};

/** An application exposed by a Sunshine/GameStream host (as reported by the Moonlight client). */
export type MoonlightApp = {
  id: string;
  title: string;
  hdrSupported: boolean;
};

export type MoonlightPairingState = "idle" | "pairing" | "failed";

export type MoonlightHost = {
  id: string;
  ownerDeviceId: string | null;
  name: string;
  address: string;
  port: number;
  /** MAC reported by the host's /serverinfo; null until known (needed for Wake-on-LAN). */
  macAddress: string | null;
  status: HostStatus;
  paired: boolean;
  /** PIN to type in the Sunshine web UI while pairing is in progress. */
  pendingPin: string | null;
  pairingState: MoonlightPairingState;
  lastError: string | null;
  gpuModel: string | null;
  hostVersion: string | null;
  apps: MoonlightApp[];
  lastSeenAt: string;
  createdAt: string;
};

export type MoonlightClientInfo = {
  installed: boolean;
  path: string | null;
  downloadUrl: string;
};

/** A PS4/PS5 found on the network via Sony's discovery protocol. */
export type PlayStationConsole = {
  address: string;
  hostId: string;
  name: string;
  type: "PS4" | "PS5";
  state: "ready" | "standby" | "unknown";
  systemVersion: string | null;
  runningApp: string | null;
  /** Registered in chiaki-ng (required to stream). */
  registered: boolean;
};

export type PlayStationClientInfo = {
  installed: boolean;
  path: string | null;
  /** Console nicknames registered in chiaki-ng. */
  registered: string[];
  downloadUrl: string;
};

export type StreamMetricsSample = {
  fps: number;
  bitrateMbps: number;
  encodeMs: number;
  decodeMs: number;
  networkRttMs: number;
  packetLossPct: number;
  codec: string;
  resolution: string;
  route: SessionRoute;
};

/**
 * Remote input. Pointer coordinates are normalized (0..1) relative to the video content
 * (letterboxing excluded). Keys use KeyboardEvent.code.
 */
export type RemoteInputPayload =
  | { kind: "mousemove"; x: number; y: number }
  | { kind: "mousedown"; x: number; y: number; button: number }
  | { kind: "mouseup"; x: number; y: number; button: number }
  | { kind: "wheel"; dx: number; dy: number }
  | { kind: "keydown"; code: string }
  | { kind: "keyup"; code: string }
  | { kind: "releaseAll" };

/** Messages exchanged peer-to-peer over the WebRTC data channel. */
export type PeerMessage =
  | { t: "hello"; deviceId: string; name: string }
  | { t: "input"; input: RemoteInputPayload }
  | { t: "chat"; id: string; from: string; text: string; at: number }
  | { t: "metrics"; metrics: StreamMetricsSample }
  | { t: "notice"; text: string };

export type RegisterDeviceRequest = { displayName: string };
export type RegisterDeviceResponse = { device: Device; token: string };

export type CreateHostRequest = {
  name: string;
  capabilities?: Record<string, unknown>;
  mediaEndpoint?: string | null;
};
export type CreateInvitationRequest = {
  hostId: string;
  maxUses?: number;
  expiresInSeconds?: number;
};
export type RedeemInvitationResponse = {
  session: Session;
  participant: Participant;
  permissions: PermissionSet;
  host?: Host;
};
export type SetPermissionsRequest = {
  keyboard: boolean;
  mouse: boolean;
  gamepad: boolean;
};

export type WsClientMessage =
  | { type: "subscribe"; sessionId: string }
  | { type: "media.endpoint"; sessionId: string; endpoint: string }
  | { type: "signal.offer"; sessionId: string; sdp: unknown }
  | { type: "signal.answer"; sessionId: string; sdp: unknown }
  | { type: "signal.candidate"; sessionId: string; candidate: unknown }
  | { type: "signal.ready"; sessionId: string }
  | { type: "ping" };

export type WsServerMessage =
  | { type: "hello"; deviceId: string }
  | { type: "host.updated"; host: Host }
  | { type: "session.pending"; session: Session; participant: ParticipantWithDetails }
  | { type: "session.approved"; session: Session; mediaEndpoint: string | null }
  | { type: "session.denied"; session: Session }
  | { type: "session.ended"; session: Session }
  | { type: "participant.kicked"; sessionId: string; participantId: string }
  | { type: "permissions.updated"; sessionId?: string; permissions: PermissionSet }
  | { type: "media.endpoint"; sessionId: string; endpoint: string }
  | { type: "signal.offer"; sessionId: string; fromDeviceId: string; sdp: unknown }
  | { type: "signal.answer"; sessionId: string; fromDeviceId: string; sdp: unknown }
  | { type: "signal.candidate"; sessionId: string; fromDeviceId: string; candidate: unknown }
  | { type: "signal.ready"; sessionId: string; fromDeviceId: string }
  | { type: "pong" }
  | { type: "error"; message: string };

export type SignalMessage = Extract<
  WsServerMessage,
  { type: "signal.offer" | "signal.answer" | "signal.candidate" | "signal.ready" }
>;

export const DEFAULT_SIGNAL_PORT = 8787;
export const DEFAULT_SIGNAL_URL = `http://127.0.0.1:${DEFAULT_SIGNAL_PORT}`;
export const MOONLIGHT_DOWNLOAD_URL = "https://moonlight-stream.org/";
export const CHIAKI_DOWNLOAD_URL = "https://streetpea.github.io/chiaki-ng/";
export const APP_VERSION = "0.3.0";
