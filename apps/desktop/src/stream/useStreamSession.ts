import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ParticipantWithDetails,
  PeerMessage,
  RemoteInputPayload,
  Session,
  SessionRoute,
  StreamMetricsSample,
  StreamProfile,
  WsClientMessage,
  WsServerMessage,
} from "@pulselink/protocol";
import { wsSend } from "../api";
import { buildIceServers } from "../lib/ice";
import { createSecureChannel, importSessionKey } from "../lib/secureChannel";
import { supabase } from "../supabase";

/** Signaling messages between peers. `to` addresses one peer (the host talks to many guests). */
type Sig =
  | { kind: "ready" }
  | { kind: "offer"; to: string; sdp: RTCSessionDescriptionInit }
  | { kind: "answer"; to: string; sdp: RTCSessionDescriptionInit }
  | { kind: "ice"; to: string; candidate: RTCIceCandidateInit };

export type ChatLine = { id: string; from: string; text: string; at: number; self: boolean };

export type StreamState = {
  phase: "idle" | "capturing" | "waiting" | "connecting" | "connected" | "failed";
  error: string | null;
  transport: "cloud" | "local";
  metrics: StreamMetricsSample | null;
  remoteStream: MediaStream | null;
  localStream: MediaStream | null;
  connectedPeers: string[];
  chat: ChatLine[];
  notice: string | null;
};

type Options = {
  session: Session;
  isHost: boolean;
  selfDeviceId: string;
  selfName: string;
  participants: ParticipantWithDetails[];
  profile: StreamProfile;
  remoteControl: boolean;
  wsRef: React.MutableRefObject<WebSocket | null>;
  lastWsMessage: WsServerMessage | null;
  /** "cloud": Supabase private channel (signed in). "local": the local signal server. */
  transport: "cloud" | "local";
};

const RES: Record<StreamProfile["resolution"], [number, number]> = {
  "1280x720": [1280, 720],
  "1920x1080": [1920, 1080],
  "2560x1440": [2560, 1440],
  "3840x2160": [3840, 2160],
};

const MIME: Record<string, string> = { h264: "video/H264", vp9: "video/VP9", av1: "video/AV1", hevc: "video/H265" };

function routeFromCandidate(type: string | undefined): SessionRoute {
  if (type === "relay") return "relay";
  if (type === "host") return "lan_udp";
  return "p2p";
}

export function useStreamSession(opts: Options) {
  const { session, isHost, selfDeviceId, selfName, profile, remoteControl, wsRef, lastWsMessage, transport } = opts;

  const [state, setState] = useState<StreamState>({
    phase: "idle",
    error: null,
    transport,
    metrics: null,
    remoteStream: null,
    localStream: null,
    connectedPeers: [],
    chat: [],
    notice: null,
  });
  const patch = useCallback((p: Partial<StreamState>) => setState((s) => ({ ...s, ...p })), []);

  // Latest values for use inside long-lived callbacks.
  const participantsRef = useRef(opts.participants);
  participantsRef.current = opts.participants;
  const remoteControlRef = useRef(remoteControl);
  remoteControlRef.current = remoteControl;

  const hostEncodeMsRef = useRef(0);
  const peers = useRef(new Map<string, { pc: RTCPeerConnection; dc: RTCDataChannel | null }>());
  const sendSigRef = useRef<(sig: Sig) => void>(() => {});
  const handleSigRef = useRef<(sig: Sig, from: string) => void>(() => {});

  // ------------------------------------------------------------------ data channel
  const broadcastPeer = useCallback((msg: PeerMessage, exceptId?: string) => {
    const raw = JSON.stringify(msg);
    for (const [id, p] of peers.current) {
      if (id !== exceptId && p.dc?.readyState === "open") p.dc.send(raw);
    }
  }, []);

  const addChat = useCallback((line: ChatLine) => {
    setState((s) => ({ ...s, chat: [...s.chat.slice(-99), line] }));
  }, []);

  const onPeerMessage = useCallback(
    (fromId: string, raw: string) => {
      let msg: PeerMessage;
      try {
        msg = JSON.parse(raw) as PeerMessage;
      } catch {
        return;
      }
      if (msg.t === "input" && isHost) {
        // Host-side permission enforcement: only the guest's own permission set counts.
        const guest = participantsRef.current.find(
          (p) => p.deviceId === fromId && p.role === "guest" && p.presence === "connected",
        );
        if (!guest || !remoteControlRef.current) return;
        const k = msg.input.kind;
        const isMouse = k === "mousemove" || k === "mousedown" || k === "mouseup" || k === "wheel";
        const isKey = k === "keydown" || k === "keyup";
        if ((isMouse && !guest.permissions.mouse) || (isKey && !guest.permissions.keyboard)) return;
        window.pulselinkDesktop?.injectInput(msg.input);
      } else if (msg.t === "chat") {
        addChat({ id: msg.id, from: msg.from, text: msg.text.slice(0, 500), at: msg.at, self: false });
        if (isHost) broadcastPeer(msg, fromId); // relay to the other guests
      } else if (msg.t === "metrics" && !isHost) {
        hostEncodeMsRef.current = msg.metrics.encodeMs;
      } else if (msg.t === "notice" && !isHost) {
        patch({ notice: msg.text });
      }
    },
    [addChat, broadcastPeer, isHost, patch],
  );

  const wireChannel = useCallback(
    (peerId: string, dc: RTCDataChannel) => {
      const entry = peers.current.get(peerId);
      if (entry) entry.dc = dc;
      dc.onmessage = (ev) => onPeerMessage(peerId, String(ev.data));
      dc.onopen = () => dc.send(JSON.stringify({ t: "hello", deviceId: selfDeviceId, name: selfName } satisfies PeerMessage));
    },
    [onPeerMessage, selfDeviceId, selfName],
  );

  // ------------------------------------------------------------------ peer connections
  const createPeer = useCallback(
    (peerId: string) => {
      peers.current.get(peerId)?.pc.close();
      const pc = new RTCPeerConnection({ iceServers: buildIceServers() });
      peers.current.set(peerId, { pc, dc: null });
      pc.onicecandidate = (ev) => {
        if (ev.candidate) sendSigRef.current({ kind: "ice", to: peerId, candidate: ev.candidate.toJSON() });
      };
      pc.onconnectionstatechange = () => {
        const connected = [...peers.current.entries()]
          .filter(([, p]) => p.pc.connectionState === "connected")
          .map(([id]) => id);
        setState((s) => ({
          ...s,
          connectedPeers: connected,
          phase: connected.length > 0 ? "connected" : pc.connectionState === "failed" ? "failed" : s.phase,
          error:
            pc.connectionState === "failed"
              ? "Não foi possível estabelecer conexão P2P. Configure um servidor TURN em Ajustes › Rede."
              : s.error,
        }));
      };
      return pc;
    },
    [],
  );

  const localStreamRef = useRef<MediaStream | null>(null);

  const applySenderSettings = useCallback(
    async (pc: RTCPeerConnection) => {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== "video") continue;
        const params = sender.getParameters();
        params.encodings = params.encodings?.length ? params.encodings : [{}];
        params.encodings[0]!.maxBitrate = Math.round(profile.bitrateMbps * 1_000_000);
        params.encodings[0]!.maxFramerate = profile.fps;
        params.degradationPreference = "maintain-framerate";
        await sender.setParameters(params).catch(() => {});
      }
      const mime = MIME[profile.codec];
      const caps = RTCRtpSender.getCapabilities?.("video");
      if (mime && caps) {
        const preferred = caps.codecs.filter((c) => c.mimeType.toLowerCase() === mime.toLowerCase());
        if (preferred.length) {
          const rest = caps.codecs.filter((c) => !preferred.includes(c));
          for (const t of pc.getTransceivers()) {
            if (t.sender.track?.kind === "video") t.setCodecPreferences?.([...preferred, ...rest]);
          }
        }
      }
    },
    [profile.bitrateMbps, profile.codec, profile.fps],
  );

  /** Host: build a connection for one guest and send it an offer. */
  const offerTo = useCallback(
    async (guestId: string) => {
      const stream = localStreamRef.current;
      if (!stream) return;
      const pc = createPeer(guestId);
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      wireChannel(guestId, pc.createDataChannel("pulselink", { ordered: true }));
      await applySenderSettings(pc);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSigRef.current({ kind: "offer", to: guestId, sdp: pc.localDescription!.toJSON() });
      patch({ phase: "connecting" });
    },
    [applySenderSettings, createPeer, patch, wireChannel],
  );

  handleSigRef.current = (sig, from) => {
    if (sig.kind === "ready") {
      if (isHost) void offerTo(from).catch((e) => patch({ error: String(e) }));
      return;
    }
    if ("to" in sig && sig.to !== selfDeviceId) return;
    if (sig.kind === "offer" && !isHost) {
      void (async () => {
        const pc = createPeer(from);
        pc.ontrack = (ev) => patch({ remoteStream: ev.streams[0] ?? new MediaStream([ev.track]) });
        pc.ondatachannel = (ev) => wireChannel(from, ev.channel);
        await pc.setRemoteDescription(sig.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSigRef.current({ kind: "answer", to: from, sdp: pc.localDescription!.toJSON() });
        patch({ phase: "connecting" });
      })().catch((e) => patch({ error: String(e) }));
    } else if (sig.kind === "answer" && isHost) {
      void peers.current.get(from)?.pc.setRemoteDescription(sig.sdp).catch(() => {});
    } else if (sig.kind === "ice") {
      void peers.current.get(from)?.pc.addIceCandidate(sig.candidate).catch(() => {});
    }
  };

  // ------------------------------------------------------------------ signaling transport
  useEffect(() => {
    if (session.status !== "active") return;
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    void (async () => {
      if (transport === "cloud") {
        if (!session.sessionKey) throw new Error("Sessão sem chave de cifra");
        // Private channel: the database only lets session members join (RLS on realtime.messages).
        await supabase.realtime.setAuth();
        const key = await importSessionKey(session.sessionKey);
        const secure = createSecureChannel<Sig>(key, selfDeviceId, session.id);
        channel = supabase.channel(`pl:${session.id}`, { config: { private: true, broadcast: { self: false } } });
        channel.on("broadcast", { event: "sig" }, async ({ payload }) => {
          const opened = await secure.open(payload);
          if (opened && !cancelled) handleSigRef.current(opened.message, opened.from);
        });
        sendSigRef.current = (sig) => {
          void secure.seal(sig).then((env) => channel?.send({ type: "broadcast", event: "sig", payload: env }));
        };
        channel.subscribe((status) => {
          if (status === "SUBSCRIBED" && !cancelled && !isHost) sendSigRef.current({ kind: "ready" });
        });
        patch({ transport: "cloud" });
      } else {
        // Same-machine fallback through the local signal server (membership enforced server-side).
        sendSigRef.current = (sig) => {
          let msg: WsClientMessage;
          if (sig.kind === "ready") msg = { type: "signal.ready", sessionId: session.id };
          else if (sig.kind === "ice") msg = { type: "signal.candidate", sessionId: session.id, candidate: sig };
          else msg = { type: sig.kind === "offer" ? "signal.offer" : "signal.answer", sessionId: session.id, sdp: sig };
          wsSend(wsRef.current, msg);
        };
        patch({ transport: "local" });
        if (!isHost) sendSigRef.current({ kind: "ready" });
      }
    })().catch((e) => patch({ phase: "failed", error: String(e) }));

    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
      sendSigRef.current = () => {};
    };
  }, [isHost, patch, selfDeviceId, session.id, session.sessionKey, session.status, transport, wsRef]);

  // Local WebSocket signaling messages.
  useEffect(() => {
    const m = lastWsMessage;
    if (!m || state.transport !== "local" || !("sessionId" in m) || m.sessionId !== session.id) return;
    if (m.type === "signal.ready") handleSigRef.current({ kind: "ready" }, m.fromDeviceId);
    else if (m.type === "signal.offer" || m.type === "signal.answer") handleSigRef.current(m.sdp as Sig, m.fromDeviceId);
    else if (m.type === "signal.candidate") handleSigRef.current(m.candidate as Sig, m.fromDeviceId);
  }, [lastWsMessage, session.id, state.transport]);

  // ------------------------------------------------------------------ host capture
  useEffect(() => {
    if (session.status !== "active" || !isHost) return;
    let cancelled = false;
    patch({ phase: "capturing", error: null });

    void (async () => {
      try {
        const [w, h] = RES[profile.resolution];
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { max: w }, height: { max: h }, frameRate: { ideal: profile.fps, max: profile.fps } },
          audio: profile.audio,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = stream.getVideoTracks()[0];
        if (video) {
          video.contentHint = "motion";
          await video.applyConstraints({ width: { max: w }, height: { max: h }, frameRate: { max: profile.fps } }).catch(() => {});
        }
        localStreamRef.current = stream;
        patch({ localStream: stream, phase: "waiting" });
        // Offer to guests that announced themselves before capture was ready.
        for (const p of participantsRef.current) {
          if (p.role === "guest" && p.presence === "connected" && p.deviceId !== selfDeviceId) {
            void offerTo(p.deviceId).catch(() => {});
          }
        }
      } catch (err) {
        patch({ phase: "failed", error: err instanceof Error ? err.message : "Falha ao capturar a tela" });
      }
    })();

    return () => {
      cancelled = true;
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    };
    // Re-capture when the capture settings change.
  }, [isHost, offerTo, patch, profile.audio, profile.fps, profile.resolution, selfDeviceId, session.status]);

  // Bitrate/codec changes apply live to existing connections.
  useEffect(() => {
    for (const { pc } of peers.current.values()) void applySenderSettings(pc);
  }, [applySenderSettings]);

  // ------------------------------------------------------------------ remote control lifecycle
  useEffect(() => {
    if (!isHost || session.status !== "active" || !window.pulselinkDesktop) return;
    void window.pulselinkDesktop.setRemoteInputEnabled(remoteControl);
    return () => {
      void window.pulselinkDesktop?.setRemoteInputEnabled(false);
    };
  }, [isHost, remoteControl, session.status]);

  // ------------------------------------------------------------------ metrics
  useEffect(() => {
    if (session.status !== "active") return;
    let prevBytes = 0;
    let prevAt = 0;
    const timer = setInterval(async () => {
      const first = [...peers.current.values()].find((p) => p.pc.connectionState === "connected");
      if (!first) return;
      const report = await first.pc.getStats().catch(() => null);
      if (!report) return;
      let bytes = 0;
      let fps = 0;
      let codecId: string | undefined;
      let encodeMs = 0;
      let decodeMs = 0;
      let rtt = 0;
      let lost = 0;
      let received = 0;
      let width = 0;
      let height = 0;
      let localCandidateId: string | undefined;
      report.forEach((s) => {
        const kindRtp = isHost ? "outbound-rtp" : "inbound-rtp";
        if (s.type === kindRtp && s.kind === "video") {
          bytes = isHost ? s.bytesSent ?? 0 : s.bytesReceived ?? 0;
          fps = s.framesPerSecond ?? fps;
          codecId = s.codecId;
          width = s.frameWidth ?? width;
          height = s.frameHeight ?? height;
          if (isHost && s.framesEncoded) encodeMs = (s.totalEncodeTime / s.framesEncoded) * 1000;
          if (!isHost && s.framesDecoded) decodeMs = (s.totalDecodeTime / s.framesDecoded) * 1000;
          if (!isHost) {
            lost = s.packetsLost ?? 0;
            received = s.packetsReceived ?? 0;
          }
        }
        if (s.type === "candidate-pair" && (s.nominated || s.selected) && s.state === "succeeded") {
          rtt = (s.currentRoundTripTime ?? 0) * 1000;
          localCandidateId = s.localCandidateId;
        }
      });
      const now = performance.now();
      const mbps = prevAt ? ((bytes - prevBytes) * 8) / ((now - prevAt) * 1000) : 0;
      prevBytes = bytes;
      prevAt = now;
      const codec = codecId ? String(report.get(codecId)?.mimeType ?? "").replace("video/", "") : "";
      const candType = localCandidateId ? report.get(localCandidateId)?.candidateType : undefined;
      const sample: StreamMetricsSample = {
        fps: Math.round(fps),
        bitrateMbps: Math.max(0, Number(mbps.toFixed(1))),
        encodeMs: Number(encodeMs.toFixed(1)),
        decodeMs: Number(decodeMs.toFixed(1)),
        networkRttMs: Number(rtt.toFixed(1)),
        packetLossPct: received + lost > 0 ? Number(((lost / (received + lost)) * 100).toFixed(2)) : 0,
        codec: codec || "—",
        resolution: width && height ? `${width}x${height}` : "—",
        route: routeFromCandidate(candType),
      };
      if (isHost) {
        broadcastPeer({ t: "metrics", metrics: sample });
        patch({ metrics: sample });
      } else {
        patch({ metrics: { ...sample, encodeMs: hostEncodeMsRef.current } });
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [broadcastPeer, isHost, patch, session.status]);

  // ------------------------------------------------------------------ teardown
  useEffect(() => {
    const map = peers.current;
    return () => {
      for (const { pc } of map.values()) pc.close();
      map.clear();
    };
  }, [session.id]);

  // ------------------------------------------------------------------ public API
  const sendInput = useCallback((input: RemoteInputPayload) => {
    const raw = JSON.stringify({ t: "input", input } satisfies PeerMessage);
    for (const p of peers.current.values()) if (p.dc?.readyState === "open") p.dc.send(raw);
  }, []);

  const sendChat = useCallback(
    (text: string) => {
      const clean = text.trim().slice(0, 500);
      if (!clean) return;
      const msg: PeerMessage = { t: "chat", id: crypto.randomUUID(), from: selfName, text: clean, at: Date.now() };
      broadcastPeer(msg);
      addChat({ id: msg.id, from: selfName, text: clean, at: msg.at, self: true });
    },
    [addChat, broadcastPeer, selfName],
  );

  return { state, sendInput, sendChat };
}
