import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteInputPayload, StreamMetricsSample } from "@pulselink/protocol";
import { IconChat, IconExpand, IconPower } from "../components/Icons";
import { Avatar, Kbd, PermissionToggles, Spinner, Status, Switch } from "../components/ui";
import { useApp } from "../state/AppState";
import { useStreamSession, type ChatLine } from "../stream/useStreamSession";

const ROUTE_LABEL = { lan_udp: "LAN direta", p2p: "P2P", relay: "via TURN" } as const;

function tone(value: number, good: number, mid: number, higherIsBetter = false) {
  if (higherIsBetter) return value >= good ? "good" : value >= mid ? "mid" : "bad";
  return value <= good ? "good" : value <= mid ? "mid" : "bad";
}

/** Rolling sparkline of round-trip latency. */
function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return <svg className="hud-spark" />;
  const max = Math.max(20, ...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 80},${22 - (v / max) * 20}`).join(" ");
  return (
    <svg className="hud-spark" viewBox="0 0 80 22" preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function Hud({ metrics, idle }: { metrics: StreamMetricsSample | null; idle: boolean }) {
  const [history, setHistory] = useState<number[]>([]);
  useEffect(() => {
    if (metrics) setHistory((h) => [...h.slice(-29), metrics.networkRttMs]);
  }, [metrics]);
  if (!metrics) return null;
  return (
    <div className={`hud ${idle ? "idle" : ""}`}>
      <span>
        <b>rtt</b>
        <i className={tone(metrics.networkRttMs, 20, 60)} style={{ fontStyle: "normal" }}>
          {metrics.networkRttMs.toFixed(0)} ms
        </i>
      </span>
      <Spark values={history} />
      <span>
        <b>fps</b>
        <i className={tone(metrics.fps, 55, 30, true)} style={{ fontStyle: "normal" }}>
          {metrics.fps}
        </i>
      </span>
      <span>
        <b>taxa</b>
        {metrics.bitrateMbps.toFixed(1)} Mb/s
      </span>
      <span>
        <b>perda</b>
        <i className={tone(metrics.packetLossPct, 0.5, 2)} style={{ fontStyle: "normal" }}>
          {metrics.packetLossPct.toFixed(1)}%
        </i>
      </span>
      {metrics.decodeMs ? (
        <span>
          <b>decod.</b>
          {metrics.decodeMs.toFixed(1)} ms
        </span>
      ) : null}
      <span>
        <b>rota</b>
        {ROUTE_LABEL[metrics.route]}
      </span>
      <span>
        <b>vídeo</b>
        {metrics.resolution} {metrics.codec}
      </span>
    </div>
  );
}

function ChatDrawer({ lines, onSend, onClose }: { lines: ChatLine[]; onSend: (t: string) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => endRef.current?.scrollIntoView({ block: "end" }), [lines.length]);
  return (
    <div className="drawer" onKeyDown={(e) => e.stopPropagation()} onKeyUp={(e) => e.stopPropagation()}>
      <div className="drawer-head">
        <span className="grow">Chat</span>
        <button type="button" className="btn ghost sm" onClick={onClose}>
          Fechar
        </button>
      </div>
      <div className="drawer-body">
        {lines.length === 0 ? <p className="muted" style={{ margin: 0 }}>As mensagens vão direto entre os participantes.</p> : null}
        {lines.map((l) => (
          <div key={l.id} className={`chat-line ${l.self ? "self" : ""}`}>
            <b>{l.from}</b>
            {l.text}
            <time>{new Date(l.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form
        className="drawer-foot"
        onSubmit={(e) => {
          e.preventDefault();
          onSend(text);
          setText("");
        }}
      >
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Mensagem…" maxLength={500} />
        <button type="submit" className="btn primary" disabled={!text.trim()}>
          Enviar
        </button>
      </form>
    </div>
  );
}

function VideoEl({ stream, muted }: { stream: MediaStream | null; muted?: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) {
      ref.current.srcObject = stream;
      void ref.current.play().catch(() => {});
    }
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} />;
}

// ---------------------------------------------------------------------------- guest viewer

/** Maps a client point to normalized coordinates inside the letterboxed video content. */
function videoPoint(video: HTMLVideoElement, clientX: number, clientY: number) {
  const r = video.getBoundingClientRect();
  const vw = video.videoWidth || r.width;
  const vh = video.videoHeight || r.height;
  const scale = Math.min(r.width / vw, r.height / vh);
  const w = vw * scale;
  const h = vh * scale;
  const left = r.left + (r.width - w) / 2;
  const top = r.top + (r.height - h) / 2;
  const x = (clientX - left) / w;
  const y = (clientY - top) / h;
  return { x, y, inside: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
}

const HOTKEYS = { menu: "KeyM", chat: "KeyC", end: "KeyQ", full: "KeyF" };

function GuestViewer() {
  const app = useApp();
  const session = app.session!;
  const me = app.details?.participants.find((p) => p.deviceId === app.selfDeviceId);
  const perms = me?.permissions ?? { keyboard: false, mouse: false };
  const { state, sendInput, sendChat } = useStreamSession({
    session,
    isHost: false,
    selfDeviceId: app.selfDeviceId!,
    transport: app.backendKind === "cloud" ? "cloud" : "local",
    selfName: app.cloudProfile?.username ?? app.deviceName,
    participants: app.details?.participants ?? [],
    profile: app.streamProfile,
    remoteControl: false,
    wsRef: app.wsRef,
    lastWsMessage: app.lastWsMessage,
  });

  const stageRef = useRef<HTMLDivElement | null>(null);
  const videoWrap = useRef<HTMLDivElement | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [dockVisible, setDockVisible] = useState(true);
  const [idle, setIdle] = useState(false);
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef(0);

  const video = () => videoWrap.current?.querySelector("video") ?? null;
  const send = useCallback((p: RemoteInputPayload) => sendInput(p), [sendInput]);

  // Show the dock briefly after any mouse movement.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const poke = () => {
      setDockVisible(true);
      setIdle(false);
      clearTimeout(t);
      t = setTimeout(() => {
        setDockVisible(false);
        setIdle(true);
      }, 2500);
    };
    poke();
    const el = stageRef.current;
    el?.addEventListener("pointermove", poke);
    return () => {
      clearTimeout(t);
      el?.removeEventListener("pointermove", poke);
    };
  }, []);

  // Release everything if focus leaves the stream (prevents stuck keys on the host).
  useEffect(() => {
    const release = () => send({ kind: "releaseAll" });
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("blur", release);
      release();
    };
  }, [send]);

  const onPointerMove = (e: React.PointerEvent) => {
    const v = video();
    if (!v || !perms.mouse) return;
    const p = videoPoint(v, e.clientX, e.clientY);
    if (!p.inside) return;
    pendingMove.current = p;
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        if (pendingMove.current) send({ kind: "mousemove", x: pendingMove.current.x, y: pendingMove.current.y });
      });
    }
  };
  const onPointerButton = (e: React.PointerEvent, down: boolean) => {
    stageRef.current?.focus();
    const v = video();
    if (!v || !perms.mouse) return;
    const p = videoPoint(v, e.clientX, e.clientY);
    if (down && !p.inside) return;
    send({ kind: down ? "mousedown" : "mouseup", x: p.x, y: p.y, button: e.button });
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!perms.mouse) return;
    send({ kind: "wheel", dx: e.deltaX, dy: e.deltaY });
  };
  const onKey = (e: React.KeyboardEvent, down: boolean) => {
    if (e.ctrlKey && e.shiftKey && down) {
      if (e.code === HOTKEYS.chat) return (e.preventDefault(), setChatOpen((v) => !v));
      if (e.code === HOTKEYS.end) return (e.preventDefault(), void app.endSession());
      if (e.code === HOTKEYS.full) return (e.preventDefault(), void window.pulselinkDesktop?.toggleFullScreen());
      if (e.code === HOTKEYS.menu) return (e.preventDefault(), setDockVisible((v) => !v));
    }
    if (!perms.keyboard) return;
    e.preventDefault();
    if (e.repeat && down) return send({ kind: "keydown", code: e.code });
    send({ kind: down ? "keydown" : "keyup", code: e.code });
  };

  const connected = state.phase === "connected" && state.remoteStream;

  return (
    <div
      ref={stageRef}
      className={`stream ${connected && perms.mouse ? "control" : ""}`}
      tabIndex={0}
      onPointerMove={onPointerMove}
      onPointerDown={(e) => onPointerButton(e, true)}
      onPointerUp={(e) => onPointerButton(e, false)}
      onWheel={onWheel}
      onKeyDown={(e) => onKey(e, true)}
      onKeyUp={(e) => onKey(e, false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div ref={videoWrap}>
        <VideoEl stream={state.remoteStream} />
      </div>

      {!connected ? (
        <div className="stream-center">
          {state.phase === "failed" ? null : <Spinner />}
          <h2>{state.phase === "failed" ? "Não foi possível conectar" : `Conectando a ${app.details?.host?.name ?? "host"}…`}</h2>
          <p>{state.error ?? "Procurando o caminho mais rápido até o host."}</p>
          <button type="button" className="btn danger" onClick={() => void app.endSession()}>
            Cancelar
          </button>
        </div>
      ) : (
        <Hud metrics={state.metrics} idle={idle} />
      )}

      {state.notice ? (
        <div className="stream-notice">{state.notice}</div>
      ) : null}

      <div
        className={`dock ${dockVisible || chatOpen ? "" : "hidden"}`}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
      >
        <span className="dock-info" title="Permissões concedidas pelo host">
          {perms.keyboard || perms.mouse
            ? `Controle: ${[perms.keyboard && "teclado", perms.mouse && "mouse"].filter(Boolean).join(" e ")}`
            : "Só visualização"}
        </span>
        <span className="dock-sep" />
        <button type="button" className={`dock-btn ${chatOpen ? "on" : ""}`} onClick={() => setChatOpen((v) => !v)}>
          <IconChat size={15} /> Chat
        </button>
        <button type="button" className="dock-btn" onClick={() => void window.pulselinkDesktop?.toggleFullScreen()}>
          <IconExpand size={15} /> Tela cheia
        </button>
        <span className="dock-sep" />
        <button type="button" className="dock-btn end" onClick={() => void app.endSession()}>
          <IconPower size={15} /> Sair
        </button>
      </div>

      {chatOpen ? <ChatDrawer lines={state.chat} onSend={sendChat} onClose={() => setChatOpen(false)} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------- host console

function HostConsole() {
  const app = useApp();
  const session = app.session!;
  const { state, sendChat } = useStreamSession({
    session,
    isHost: true,
    selfDeviceId: app.selfDeviceId!,
    transport: app.backendKind === "cloud" ? "cloud" : "local",
    selfName: app.cloudProfile?.username ?? app.deviceName,
    participants: app.details?.participants ?? [],
    profile: app.streamProfile,
    remoteControl: app.remoteControl,
    wsRef: app.wsRef,
    lastWsMessage: app.lastWsMessage,
  });
  const [chatOpen, setChatOpen] = useState(false);
  const injectionSupported = app.sysInfo?.inputInjectionSupported ?? false;

  return (
    <div className="host-console">
      <div className="preview">
        <VideoEl stream={state.localStream} muted />
        {!state.localStream ? (
          <div className="stream-center">
            {state.phase === "failed" ? null : <Spinner />}
            <h2>{state.phase === "failed" ? "Não foi possível capturar a tela" : "Iniciando captura…"}</h2>
            {state.error ? <p>{state.error}</p> : null}
          </div>
        ) : (
          <Hud metrics={state.metrics} idle={false} />
        )}
        {chatOpen ? <ChatDrawer lines={state.chat} onSend={sendChat} onClose={() => setChatOpen(false)} /> : null}
      </div>

      <aside className="host-side">
        <div>
          <h1>{app.details?.host?.name ?? app.deviceName}</h1>
          <div className="row" style={{ marginTop: 6 }}>
            <Status tone={state.connectedPeers.length ? "on" : "idle"}>
              {state.connectedPeers.length ? `Transmitindo para ${state.connectedPeers.length}` : "Aguardando convidado"}
            </Status>
          </div>
          <p className="row-desc">
            {state.transport === "cloud" ? "Conexão pela sua conta, em canal privado e cifrado." : "Conexão pela rede local."}
          </p>
        </div>

        <div className="list">
          <div className="list-row">
            <div className="grow">
              <div className="row-title">Controle remoto</div>
              <p className="row-desc">
                {injectionSupported ? "Aplica teclado e mouse de quem você liberar." : "Disponível apenas no Windows."}
              </p>
            </div>
            <Switch
              label="Permitir controle remoto"
              checked={app.remoteControl && injectionSupported}
              disabled={!injectionSupported}
              onChange={app.setRemoteControl}
            />
          </div>
        </div>

        <div>
          <h2 className="block-title">Convidados</h2>
          <div className="list">
            {app.guests.map((g) => (
              <div key={g.id} className="list-row">
                <Avatar name={g.displayName} />
                <div className="grow">
                  <div className="row-title">{g.displayName}</div>
                  <div className="row-meta">{state.connectedPeers.includes(g.deviceId) ? "Assistindo" : "Conectando…"}</div>
                </div>
                <PermissionToggles perms={g.permissions} onToggle={(k) => void app.togglePermission(g, k)} />
                <button type="button" className="btn ghost sm" onClick={() => void app.kick(g)}>
                  Remover
                </button>
              </div>
            ))}
            {app.guests.length === 0 ? <div className="list-empty">Ninguém conectado. Gere um código na tela Computadores.</div> : null}
          </div>
        </div>

        <div className="row">
          <button type="button" className="btn" onClick={() => setChatOpen((v) => !v)}>
            <IconChat size={15} /> Chat
          </button>
          <div className="grow" />
          <button type="button" className="btn danger" onClick={() => void app.endSession()}>
            Encerrar sessão
          </button>
        </div>

        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          Atalhos do convidado: <Kbd keys={["Ctrl", "Shift", "Q"]} /> sair · <Kbd keys={["Ctrl", "Shift", "C"]} /> chat
        </p>
      </aside>
    </div>
  );
}

export function StreamView() {
  const app = useApp();
  if (!app.session) {
    return (
      <div className="page">
        <h1>Nenhuma sessão ativa</h1>
        <p className="subtitle">Conecte-se a um computador ou aceite um convidado para começar.</p>
        <div className="row" style={{ marginTop: 16 }}>
          <button type="button" className="btn" onClick={() => app.setView("computers")}>
            Ir para Computadores
          </button>
        </div>
      </div>
    );
  }
  if (app.session.status === "pending") {
    return (
      <div className="stream">
        <div className="stream-center">
          <Spinner />
          <h2>Aguardando {app.details?.host?.name ?? "o host"} aceitar…</h2>
          <p>O dono do computador recebe um aviso e precisa aprovar sua entrada.</p>
          <button type="button" className="btn danger" onClick={() => void app.endSession()}>
            Cancelar
          </button>
        </div>
      </div>
    );
  }
  return app.isSessionHost ? <HostConsole /> : <GuestViewer />;
}
