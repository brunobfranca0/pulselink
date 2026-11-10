import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Friendship,
  Host,
  Invitation,
  MoonlightClientInfo,
  MoonlightHost,
  ParticipantWithDetails,
  PlayStationClientInfo,
  PlayStationConsole,
  Session,
  SessionDetails,
  StreamProfile,
  WsServerMessage,
} from "@pulselink/protocol";
import {
  api,
  connectWs,
  getSignalUrl,
  loadAuth,
  loadStreamProfile,
  saveStreamProfile,
  setSignalUrl as persistSignalUrl,
  wsSubscribe,
  type CaptureSourceInfo,
  type DisplayInfo,
  type StoredAuth,
  type SystemHardwareInfo,
} from "../api";
import { createLocalBackend, ensureLocalAuth, resetLocalAuth, type Backend } from "../lib/backend";
import { createCloudBackend } from "../lib/cloudBackend";
import { CLOUD_CONFIGURED, supabase, type CloudProfile } from "../supabase";

export type View = "computers" | "moonlight" | "playstation" | "friends" | "stream" | "settings";
export type SettingsTab = "account" | "streaming" | "host" | "network" | "about";
export type Toast = { id: number; text: string; kind: "info" | "error" };

const REMOTE_CONTROL_KEY = "pulselink.remoteControl";
const PS_ADDRESSES_KEY = "pulselink.playstationAddresses";
const HEARTBEAT_MS = 30_000;

function loadPsAddresses(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(PS_ADDRESSES_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function errMsg(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}

function useAppStateValue() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const isGuestWindow = params.get("role") === "guest";
  const guestWindowNum = params.get("guestId") ?? "1";

  // ---------------------------------------------------------------- navigation + feedback
  const [view, setView] = useState<View>("computers");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("streaming");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busy, setBusy] = useState(false);
  const notify = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 3600);
  }, []);
  const fail = useCallback((err: unknown, fallback: string) => notify(errMsg(err, fallback), "error"), [notify]);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>, fallback: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        return await fn();
      } catch (err) {
        fail(err, fallback);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [fail],
  );

  // ---------------------------------------------------------------- environment (this PC)
  const [deviceName, setDeviceName] = useState(
    () => loadAuth()?.device.displayName ?? (isGuestWindow ? `Convidado ${guestWindowNum}` : "Meu PC"),
  );
  const [signalOk, setSignalOk] = useState<boolean | null>(null);
  const [signalUrl, setSignalUrlState] = useState(getSignalUrl);
  const [sysInfo, setSysInfo] = useState<SystemHardwareInfo | null>(null);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [captureSources, setCaptureSources] = useState<CaptureSourceInfo[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState("");

  const refreshDesktop = useCallback(async () => {
    const bridge = window.pulselinkDesktop;
    if (!bridge) return;
    const [d, s] = await Promise.all([bridge.getDisplays(), bridge.getCaptureSources()]);
    setDisplays(d);
    setCaptureSources(s);
    setSelectedSourceId((cur) => {
      if (cur && s.some((x) => x.id === cur)) return cur;
      const first = s.find((x) => x.kind === "screen") ?? s[0];
      if (first) void bridge.selectCaptureSource(first.id);
      return first?.id ?? "";
    });
  }, []);

  useEffect(() => {
    const bridge = window.pulselinkDesktop;
    if (!bridge) return;
    void bridge.getSystemInfo().then((info) => {
      setSysInfo(info);
      if (!loadAuth() && !isGuestWindow && info.hostname) setDeviceName(info.hostname);
    });
    void refreshDesktop();
  }, [isGuestWindow, refreshDesktop]);

  const selectCaptureSource = useCallback(async (id: string) => {
    setSelectedSourceId(id);
    await window.pulselinkDesktop?.selectCaptureSource(id);
  }, []);

  // ---------------------------------------------------------------- stream settings
  const [streamProfile, setStreamProfile] = useState<StreamProfile>(loadStreamProfile);
  const updateProfile = useCallback(<K extends keyof StreamProfile>(key: K, value: StreamProfile[K]) => {
    setStreamProfile((prev) => {
      const next = { ...prev, [key]: value };
      saveStreamProfile(next);
      return next;
    });
  }, []);
  const [remoteControl, setRemoteControlState] = useState(() => localStorage.getItem(REMOTE_CONTROL_KEY) !== "0");
  const setRemoteControl = useCallback((on: boolean) => {
    localStorage.setItem(REMOTE_CONTROL_KEY, on ? "1" : "0");
    setRemoteControlState(on);
  }, []);

  // ---------------------------------------------------------------- local service identity
  // Always present: Moonlight, PlayStation and the no-account mode use the bundled local server.
  const [localAuth, setLocalAuth] = useState<StoredAuth | null>(() => loadAuth());
  const localAuthRef = useRef(localAuth);
  localAuthRef.current = localAuth;
  const deviceNameRef = useRef(deviceName);
  deviceNameRef.current = deviceName;

  const ensureLocal = useCallback(async (): Promise<StoredAuth> => {
    if (localAuthRef.current) return localAuthRef.current;
    const a = await ensureLocalAuth(deviceNameRef.current);
    setLocalAuth(a);
    return a;
  }, []);

  // ---------------------------------------------------------------- cloud account
  const [cloudUserId, setCloudUserId] = useState<string | null>(null);
  const [cloudEmail, setCloudEmail] = useState<string | null>(null);
  const [cloudProfile, setCloudProfile] = useState<CloudProfile | null>(null);
  const [authReady, setAuthReady] = useState(!CLOUD_CONFIGURED);

  useEffect(() => {
    if (!CLOUD_CONFIGURED) return;
    const apply = (userId: string | null, email: string | null) => {
      setCloudUserId(userId);
      setCloudEmail(email);
      setAuthReady(true);
    };
    void supabase.auth.getSession().then(({ data }) => apply(data.session?.user.id ?? null, data.session?.user.email ?? null));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => apply(s?.user.id ?? null, s?.user.email ?? null));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!cloudUserId) {
      setCloudProfile(null);
      return;
    }
    void supabase
      .from("profiles")
      .select("id, username, discriminator, plan")
      .eq("id", cloudUserId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setCloudProfile({ ...(data as Omit<CloudProfile, "email">), email: cloudEmail ?? "" });
      });
  }, [cloudEmail, cloudUserId]);

  const signIn = useCallback(
    async (mode: "login" | "signup", email: string, password: string, username: string) => {
      if (mode === "signup") {
        const clean = username.trim() || email.split("@")[0] || "user";
        const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { username: clean } } });
        if (error) throw error;
        if (data.session) {
          notify(`Conta criada — bem-vindo, ${clean}`);
          return true;
        }
        notify("Confirme seu e-mail para concluir o cadastro.");
        return false;
      }
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      notify("Sessão iniciada");
      return true;
    },
    [notify],
  );

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    notify("Você saiu da conta.");
  }, [notify]);

  const saveUsername = useCallback(
    async (username: string) => {
      if (!cloudUserId) return;
      const { data, error } = await supabase
        .from("profiles")
        .update({ username: username.trim().slice(0, 32), updated_at: new Date().toISOString() })
        .eq("id", cloudUserId)
        .select("id, username, discriminator, plan")
        .single();
      if (error) return fail(error, "Não foi possível atualizar o nome");
      setCloudProfile({ ...(data as Omit<CloudProfile, "email">), email: cloudEmail ?? "" });
      notify(`Nome atualizado para ${data.username}#${data.discriminator}`);
    },
    [cloudEmail, cloudUserId, fail, notify],
  );

  // ---------------------------------------------------------------- active backend
  const [backend, setBackend] = useState<Backend | null>(null);
  const backendRef = useRef(backend);
  backendRef.current = backend;

  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = cloudUserId
          ? await createCloudBackend(cloudUserId, deviceNameRef.current)
          : createLocalBackend(await ensureLocal());
        if (!cancelled) setBackend(next);
      } catch (err) {
        if (!cancelled) fail(err, "Não foi possível conectar");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authReady, cloudUserId, ensureLocal, fail]);

  const requireBackend = useCallback((): Backend => {
    const b = backendRef.current;
    if (!b) throw new Error("Conectando… tente de novo em instantes");
    return b;
  }, []);

  // ---------------------------------------------------------------- hosts, sessions, friends
  const [myHost, setMyHost] = useState<Host | null>(null);
  const [availableHosts, setAvailableHosts] = useState<Host[]>([]);
  const [invite, setInvite] = useState<Invitation | null>(null);
  const [pending, setPending] = useState<SessionDetails[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [details, setDetails] = useState<SessionDetails | null>(null);
  const [friends, setFriends] = useState<Friendship[]>([]);
  const [moonlightHosts, setMoonlightHosts] = useState<MoonlightHost[]>([]);
  const [moonlightClient, setMoonlightClient] = useState<MoonlightClientInfo | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const refreshAll = useCallback(async () => {
    try {
      await api.health();
      setSignalOk(true);
    } catch {
      setSignalOk(false);
    }
    const b = backendRef.current;
    if (!b) return;
    try {
      const [hosts, sessions, fr] = await Promise.all([b.listHosts(), b.listSessions(), b.listFriends()]);
      const mine = hosts.myHosts[0] ?? null;
      setMyHost(mine);
      setAvailableHosts(hosts.availableHosts);
      setPending(sessions.pending);
      setFriends(fr);
      if (mine) {
        const invites = await b.listInvites(mine.id);
        setInvite(invites.find((i) => Date.parse(i.expiresAt) > Date.now() && i.useCount < i.maxUses) ?? null);
      } else {
        setInvite(null);
      }
      const current = sessions.active[0];
      const prev = sessionRef.current;
      if (current) {
        if (prev?.id === current.session.id && prev.status === "pending" && current.session.status === "active") {
          setView("stream");
          notify("Conexão aprovada — iniciando transmissão");
        }
        setSession(current.session);
        setDetails(current);
      } else if (prev) {
        setSession(null);
        setDetails(null);
        setView((v) => (v === "stream" ? "computers" : v));
        notify(prev.status === "pending" ? "O pedido de conexão foi encerrado." : "Transmissão encerrada.");
      }
    } catch (err) {
      if (b.kind === "local" && errMsg(err, "").includes("Unauthorized")) {
        // Local database was reset: register this PC again.
        resetLocalAuth();
        setLocalAuth(null);
        setBackend(null);
        const a = await ensureLocal().catch(() => null);
        if (a) setBackend(createLocalBackend(a));
      }
    }
    // Local-network features always use the local service.
    const la = localAuthRef.current;
    if (la) {
      const [ml, mlClient] = await Promise.all([
        api.listMoonlightHosts(la.token).catch(() => null),
        api.moonlightClient(la.token).catch(() => null),
      ]);
      if (ml) setMoonlightHosts(ml);
      if (mlClient) setMoonlightClient(mlClient);
    }
  }, [ensureLocal, notify]);

  useEffect(() => {
    void refreshAll();
    const t = setInterval(() => void refreshAll(), 5000);
    return () => clearInterval(t);
  }, [refreshAll, backend]);

  // Cloud: live updates (RLS-filtered change events) on top of polling.
  useEffect(() => {
    if (!backend || backend.kind !== "cloud") return;
    let pendingRefresh: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = backend.subscribe(() => {
      clearTimeout(pendingRefresh);
      pendingRefresh = setTimeout(() => void refreshAll(), 250);
    });
    return () => {
      clearTimeout(pendingRefresh);
      unsubscribe();
    };
  }, [backend, refreshAll]);

  // Cloud hosts must heartbeat or they are shown offline to others.
  useEffect(() => {
    if (!backend || backend.kind !== "cloud" || myHost?.status !== "online") return;
    const id = myHost.id;
    void backend.heartbeat(id);
    const t = setInterval(() => void backend.heartbeat(id), HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [backend, myHost?.id, myHost?.status]);

  const reloadDetails = useCallback(async (sessionId: string) => {
    const b = backendRef.current;
    if (!b) return null;
    const d = await b.sessionDetails(sessionId);
    if (d) {
      setDetails(d);
      setSession(d.session);
    }
    return d;
  }, []);

  // ---------------------------------------------------------------- local websocket
  // Carries local-mode events and same-PC WebRTC signaling.
  const wsRef = useRef<WebSocket | null>(null);
  const [lastWsMessage, setLastWsMessage] = useState<WsServerMessage | null>(null);

  useEffect(() => {
    if (!localAuth) return;
    let closed = false;
    let ws: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    const open = () => {
      ws = connectWs(localAuth.token, (msg) => {
        setLastWsMessage(msg);
        if (backendRef.current?.kind !== "local") return;
        if (msg.type === "session.pending" && msg.participant.deviceId !== localAuth.device.id) {
          notify(`${msg.participant.displayName} quer se conectar a este computador`);
        }
        if (
          msg.type === "session.approved" ||
          msg.type === "session.pending" ||
          msg.type === "session.denied" ||
          msg.type === "session.ended" ||
          msg.type === "permissions.updated" ||
          msg.type === "participant.kicked" ||
          msg.type === "host.updated"
        ) {
          void refreshAll();
        }
      });
      ws.addEventListener("close", () => {
        if (!closed) retry = setTimeout(open, 2000);
      });
      wsRef.current = ws;
    };
    open();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
      wsRef.current = null;
    };
  }, [localAuth, notify, refreshAll]);

  useEffect(() => {
    if (session && wsRef.current && backend?.kind === "local") wsSubscribe(wsRef.current, session.id);
  }, [backend, session]);

  // ---------------------------------------------------------------- host actions
  const hostCaps = useCallback(
    () => ({
      resolution: streamProfile.resolution,
      fps: streamProfile.fps,
      os: sysInfo?.platform,
      displays: displays.length || 1,
    }),
    [displays.length, streamProfile.fps, streamProfile.resolution, sysInfo?.platform],
  );

  const setHosting = useCallback(
    (online: boolean) =>
      run(async () => {
        const host = await requireBackend().setHost({ name: deviceName, online, capabilities: hostCaps() });
        setMyHost(host);
        notify(online ? "Computador disponível para conexões" : "Conexões pausadas");
      }, "Falha ao alterar a disponibilidade"),
    [deviceName, hostCaps, notify, requireBackend, run],
  );

  const createShareLink = useCallback(
    () =>
      run(async () => {
        const b = requireBackend();
        let host = myHost;
        if (!host || host.status !== "online") {
          host = await b.setHost({ name: deviceName, online: true, capabilities: hostCaps() });
          setMyHost(host);
        }
        const inv = await b.createInvite(host.id);
        setInvite(inv);
        await navigator.clipboard.writeText(inv.code).catch(() => {});
        notify("Código de acesso criado e copiado");
      }, "Falha ao criar o código"),
    [deviceName, hostCaps, myHost, notify, requireBackend, run],
  );

  const openSession = useCallback(
    async (sessionId: string) => {
      setView("stream");
      const d = await reloadDetails(sessionId);
      return d;
    },
    [reloadDetails],
  );

  const joinWithCode = useCallback(
    (raw: string) =>
      run(async () => {
        const code = raw.trim().replace(/^pulselink:\/\/join\//i, "").replace(/^#/, "");
        const sid = await requireBackend().redeem(code);
        const d = await openSession(sid);
        notify(d?.session.status === "active" ? "Conectando…" : "Aguardando aprovação do host…");
        return true;
      }, "Código inválido ou expirado"),
    [notify, openSession, requireBackend, run],
  );

  const connectToHost = useCallback(
    (host: Host) =>
      run(async () => {
        const sid = await requireBackend().connectHost(host.id, streamProfile);
        const d = await openSession(sid);
        notify(d?.session.status === "active" ? `Conectando a ${host.name}…` : `Aguardando ${host.name} aprovar…`);
      }, "Falha ao conectar"),
    [notify, openSession, requireBackend, run, streamProfile],
  );

  const approve = useCallback(
    (sessionId: string) =>
      run(async () => {
        await requireBackend().approve(sessionId);
        setPending((p) => p.filter((x) => x.session.id !== sessionId));
        await openSession(sessionId);
        notify("Convidado aprovado — transmitindo");
      }, "Falha ao aprovar"),
    [notify, openSession, requireBackend, run],
  );

  const deny = useCallback(
    (sessionId: string) =>
      run(async () => {
        await requireBackend().deny(sessionId);
        setPending((p) => p.filter((x) => x.session.id !== sessionId));
        notify("Pedido recusado");
      }, "Falha ao recusar"),
    [notify, requireBackend, run],
  );

  const endSession = useCallback(async () => {
    const s = sessionRef.current;
    const b = backendRef.current;
    if (s && b) await b.end(s.id).catch(() => {});
    setSession(null);
    setDetails(null);
    setView((v) => (v === "stream" ? "computers" : v));
    void refreshAll();
  }, [refreshAll]);

  const togglePermission = useCallback(
    async (p: ParticipantWithDetails, key: "keyboard" | "mouse") => {
      const s = sessionRef.current;
      if (!s) return;
      try {
        await requireBackend().setPermissions(s.id, p.id, {
          keyboard: key === "keyboard" ? !p.permissions.keyboard : p.permissions.keyboard,
          mouse: key === "mouse" ? !p.permissions.mouse : p.permissions.mouse,
        });
        await reloadDetails(s.id);
      } catch (err) {
        fail(err, "Falha ao alterar permissões");
      }
    },
    [fail, reloadDetails, requireBackend],
  );

  const kick = useCallback(
    async (p: ParticipantWithDetails) => {
      const s = sessionRef.current;
      if (!s) return;
      try {
        await requireBackend().kick(s.id, p.id);
        await reloadDetails(s.id);
        notify(`${p.displayName} foi desconectado`);
      } catch (err) {
        fail(err, "Falha ao remover convidado");
      }
    },
    [fail, notify, reloadDetails, requireBackend],
  );

  const addFriend = useCallback(
    (input: string) =>
      run(async () => {
        const f = await requireBackend().addFriend(input.trim());
        setFriends(await requireBackend().listFriends());
        notify(`${f.friendName} agora vê seus computadores`);
        return true;
      }, "Não foi possível adicionar"),
    [notify, requireBackend, run],
  );
  const updateFriend = useCallback(
    async (f: Friendship, patch: Partial<Pick<Friendship, "keyboard" | "mouse" | "autoConnect">>) => {
      try {
        const updated = await requireBackend().updateFriend(f.id, patch);
        setFriends((prev) => prev.map((x) => (x.id === f.id ? updated : x)));
      } catch (err) {
        fail(err, "Falha ao atualizar amigo");
      }
    },
    [fail, requireBackend],
  );
  const removeFriend = useCallback(
    async (f: Friendship) => {
      try {
        await requireBackend().removeFriend(f.id);
        setFriends((prev) => prev.filter((x) => x.id !== f.id));
        notify(`${f.friendName} removido`);
      } catch (err) {
        fail(err, "Falha ao remover amigo");
      }
    },
    [fail, notify, requireBackend],
  );

  const renameDevice = useCallback(
    async (name: string) => {
      if (!name.trim()) return;
      try {
        await requireBackend().renameDevice(name.trim());
        setDeviceName(name.trim());
        notify("Nome do computador atualizado");
        void refreshAll();
      } catch (err) {
        fail(err, "Falha ao renomear");
      }
    },
    [fail, notify, refreshAll, requireBackend],
  );

  // ---------------------------------------------------------------- moonlight (local network)
  const mlUpdate = useCallback((h: MoonlightHost) => {
    setMoonlightHosts((prev) => (prev.some((x) => x.id === h.id) ? prev.map((x) => (x.id === h.id ? h : x)) : [...prev, h]));
  }, []);

  const moonlight = useMemo(
    () => ({
      scan: () =>
        run(async () => {
          const a = await ensureLocal();
          const hosts = await api.scanMoonlightLan(a.token);
          setMoonlightHosts(hosts);
          notify(hosts.length ? `${hosts.length} host(s) Sunshine encontrados` : "Nenhum host Sunshine encontrado na rede");
        }, "Falha na busca"),
      add: (address: string, name?: string, port?: number) =>
        run(async () => {
          const a = await ensureLocal();
          const h = await api.addMoonlightHost(a.token, { address, name, port });
          mlUpdate(h);
          notify(h.status === "online" ? `${h.name} adicionado` : `${h.name} adicionado (offline agora)`);
          return h;
        }, "Falha ao adicionar host"),
      pair: (h: MoonlightHost) =>
        run(async () => {
          const a = await ensureLocal();
          const updated = await api.pairMoonlightHost(a.token, h.id);
          mlUpdate(updated);
          return updated;
        }, "Falha ao iniciar pareamento"),
      poll: async (id: string) => {
        const a = localAuthRef.current;
        if (!a) return null;
        const h = await api.getMoonlightHost(a.token, id).catch(() => null);
        if (h) mlUpdate(h);
        return h;
      },
      cancelPair: async (h: MoonlightHost) => {
        const a = localAuthRef.current;
        if (a) mlUpdate(await api.cancelMoonlightPairing(a.token, h.id));
      },
      unpair: (h: MoonlightHost) =>
        run(async () => {
          const a = await ensureLocal();
          mlUpdate(await api.unpairMoonlightHost(a.token, h.id));
          notify("Pareamento removido. Remova também o cliente na interface web do Sunshine.");
        }, "Falha ao remover pareamento"),
      refreshApps: (h: MoonlightHost) =>
        run(async () => {
          const a = await ensureLocal();
          mlUpdate(await api.refreshMoonlightApps(a.token, h.id));
        }, "Falha ao listar apps"),
      wake: (h: MoonlightHost) =>
        run(async () => {
          const a = await ensureLocal();
          await api.wakeMoonlightHost(a.token, h.id);
          notify(`Pacote Wake-on-LAN enviado para ${h.macAddress}`);
        }, "Falha no Wake-on-LAN"),
      launch: (h: MoonlightHost, appTitle: string) =>
        run(async () => {
          const a = await ensureLocal();
          await api.launchMoonlightApp(a.token, h.id, appTitle, streamProfile);
          notify(`Abrindo ${appTitle} no Moonlight…`);
        }, "Falha ao abrir o Moonlight"),
      remove: (h: MoonlightHost) =>
        run(async () => {
          const a = await ensureLocal();
          await api.deleteMoonlightHost(a.token, h.id);
          setMoonlightHosts((prev) => prev.filter((x) => x.id !== h.id));
        }, "Falha ao remover host"),
    }),
    [ensureLocal, mlUpdate, notify, run, streamProfile],
  );

  // ---------------------------------------------------------------- playstation (local network)
  const [psClient, setPsClient] = useState<PlayStationClientInfo | null>(null);
  const [psConsoles, setPsConsoles] = useState<PlayStationConsole[]>([]);
  const [psScanning, setPsScanning] = useState(false);
  const [psAddresses, setPsAddresses] = useState<string[]>(loadPsAddresses);

  const playstation = useMemo(
    () => ({
      discover: async (extra: string[] = psAddresses) => {
        setPsScanning(true);
        try {
          const a = await ensureLocal();
          const [client, consoles] = await Promise.all([
            api.playstationClient(a.token),
            api.discoverPlayStations(a.token, extra),
          ]);
          setPsClient(client);
          setPsConsoles(consoles);
          return consoles;
        } catch (err) {
          fail(err, "Falha ao procurar consoles");
          return [];
        } finally {
          setPsScanning(false);
        }
      },
      addAddress: (address: string) => {
        const clean = address.trim();
        if (!clean) return;
        const next = [...new Set([...psAddresses, clean])].slice(-16);
        localStorage.setItem(PS_ADDRESSES_KEY, JSON.stringify(next));
        setPsAddresses(next);
      },
      removeAddress: (address: string) => {
        const next = psAddresses.filter((x) => x !== address);
        localStorage.setItem(PS_ADDRESSES_KEY, JSON.stringify(next));
        setPsAddresses(next);
      },
      launch: (c: PlayStationConsole, fullscreen: boolean) =>
        run(async () => {
          const a = await ensureLocal();
          await api.launchPlayStation(a.token, c.name, c.address, fullscreen);
          notify(`Abrindo ${c.name} no chiaki-ng…`);
        }, "Falha ao abrir o Remote Play"),
      openClient: () =>
        run(async () => {
          const a = await ensureLocal();
          await api.openChiaki(a.token);
        }, "Falha ao abrir o chiaki-ng"),
    }),
    [ensureLocal, fail, notify, psAddresses, run],
  );

  // ---------------------------------------------------------------- misc
  const setSignalUrl = useCallback(
    (url: string) => {
      persistSignalUrl(url);
      setSignalUrlState(getSignalUrl());
      notify("Endereço do serviço local atualizado");
      void refreshAll();
    },
    [notify, refreshAll],
  );

  const selfDeviceId = backend?.deviceId ?? null;
  const isSessionHost = Boolean(session && selfDeviceId && details?.host?.ownerDeviceId === selfDeviceId);
  const guests = (details?.participants ?? []).filter((p) => p.role === "guest" && p.presence === "connected");

  return {
    isGuestWindow,
    view,
    setView,
    settingsTab,
    setSettingsTab,
    toasts,
    notify,
    busy,
    backendKind: backend?.kind ?? null,
    selfDeviceId,
    friendCode: backend?.friendCode ?? null,
    deviceName,
    renameDevice,
    signalOk,
    signalUrl,
    setSignalUrl,
    sysInfo,
    displays,
    captureSources,
    selectedSourceId,
    selectCaptureSource,
    refreshDesktop,
    streamProfile,
    updateProfile,
    remoteControl,
    setRemoteControl,
    myHost,
    availableHosts,
    invite,
    pending,
    session,
    details,
    guests,
    isSessionHost,
    friends,
    moonlightHosts,
    moonlightClient,
    psClient,
    psConsoles,
    psScanning,
    psAddresses,
    playstation,
    cloudProfile,
    signedIn: Boolean(cloudUserId),
    signIn,
    signOut,
    saveUsername,
    refreshAll,
    setHosting,
    createShareLink,
    joinWithCode,
    connectToHost,
    approve,
    deny,
    endSession,
    togglePermission,
    kick,
    addFriend,
    updateFriend,
    removeFriend,
    moonlight,
    wsRef,
    lastWsMessage,
  };
}

export type AppState = ReturnType<typeof useAppStateValue>;

const Ctx = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const value = useAppStateValue();
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside <AppStateProvider>");
  return v;
}
