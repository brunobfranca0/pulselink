import { useEffect, useState } from "react";
import { APP_VERSION, type StreamProfile } from "@pulselink/protocol";
import { IconLogout, IconRefresh } from "../components/Icons";
import { Kbd, Modal, Segmented, Status, Switch } from "../components/ui";
import { TURN_CONFIGURED, TURN_SUMMARY } from "../lib/ice";
import { useApp, type SettingsTab } from "../state/AppState";
import { CLOUD_CONFIGURED, SUPABASE_URL } from "../supabase";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "streaming", label: "Transmissão" },
  { id: "host", label: "Host" },
  { id: "network", label: "Rede" },
  { id: "account", label: "Conta" },
  { id: "about", label: "Sobre" },
];

function Row({ title, desc, children }: { title: string; desc?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="list-row">
      <div className="grow">
        <div className="row-title">{title}</div>
        {desc ? <p className="row-desc">{desc}</p> : null}
      </div>
      {children}
    </div>
  );
}

function StreamingTab() {
  const { streamProfile: p, updateProfile } = useApp();
  return (
    <div className="list">
      <Row title="Resolução máxima" desc="Limite de captura no host. A janela do convidado escala o vídeo.">
        <Segmented<StreamProfile["resolution"]>
          label="Resolução"
          value={p.resolution}
          onChange={(v) => updateProfile("resolution", v)}
          options={[
            { value: "1280x720", label: "720p" },
            { value: "1920x1080", label: "1080p" },
            { value: "2560x1440", label: "1440p" },
            { value: "3840x2160", label: "4K" },
          ]}
        />
      </Row>
      <Row title="Quadros por segundo">
        <Segmented<StreamProfile["fps"]>
          label="FPS"
          value={p.fps}
          onChange={(v) => updateProfile("fps", v)}
          options={[30, 60, 120, 144].map((v) => ({ value: v as StreamProfile["fps"], label: String(v) }))}
        />
      </Row>
      <Row title="Taxa de bits" desc="Teto do codificador. Na Wi-Fi, 10–20 Mbps costumam ser mais estáveis.">
        <div className="row">
          <input
            type="range"
            min={2}
            max={100}
            step={1}
            value={p.bitrateMbps}
            onChange={(e) => updateProfile("bitrateMbps", Number(e.target.value))}
            aria-label="Taxa de bits"
            style={{ width: 180, accentColor: "#d4d4d8" }}
          />
          <span className="mono" style={{ width: 70, textAlign: "right" }}>
            {p.bitrateMbps} Mbps
          </span>
        </div>
      </Row>
      <Row title="Codec preferido" desc="Usado se os dois lados suportarem; senão a negociação escolhe outro.">
        <Segmented<StreamProfile["codec"]>
          label="Codec"
          value={p.codec}
          onChange={(v) => updateProfile("codec", v)}
          options={[
            { value: "auto", label: "auto" },
            { value: "h264", label: "H.264" },
            { value: "vp9", label: "VP9" },
            { value: "av1", label: "AV1" },
          ]}
        />
      </Row>
      <Row title="Áudio do sistema" desc="Transmite o som do host junto com a tela.">
        <Switch label="Áudio do sistema" checked={p.audio} onChange={(v) => updateProfile("audio", v)} />
      </Row>
    </div>
  );
}

function HostTab() {
  const app = useApp();
  const injection = app.sysInfo?.inputInjectionSupported ?? false;
  return (
    <div className="stack">
      <div className="list">
        <Row title="Permitir controle remoto" desc="Teclado e mouse de convidados liberados são aplicados neste PC. Você escolhe as permissões de cada um.">
          <Switch label="Permitir controle remoto" checked={app.remoteControl && injection} disabled={!injection} onChange={app.setRemoteControl} />
        </Row>
        <Row title="Nome deste computador">
          <RenameField />
        </Row>
      </div>
      <div className="list">
        <div className="list-row">
          <div className="grow">
            <div className="row-title">O que transmitir</div>
            <p className="row-desc">Uma tela inteira ou uma janela. O mouse do convidado é mapeado para a área escolhida.</p>
          </div>
          <button type="button" className="btn ghost icon" aria-label="Atualizar fontes" onClick={() => void app.refreshDesktop()}>
            <IconRefresh size={15} />
          </button>
        </div>
        <div className="sources">
          {app.captureSources.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`source ${app.selectedSourceId === s.id ? "on" : ""}`}
              onClick={() => void app.selectCaptureSource(s.id)}
            >
              <img src={s.thumbnailDataUrl} alt="" width={160} height={90} />
              <span>
                <span className="muted" style={{ marginRight: 6 }}>
                  {s.kind === "screen" ? "Tela" : "Janela"}
                </span>
                {s.name}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function RenameField() {
  const app = useApp();
  const [name, setName] = useState(app.deviceName);
  useEffect(() => setName(app.deviceName), [app.deviceName]);
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        void app.renameDevice(name);
      }}
    >
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} aria-label="Nome do computador" />
      <button type="submit" className="btn" disabled={!name.trim()}>
        Salvar
      </button>
    </form>
  );
}

function NetworkTab() {
  const app = useApp();
  const [url, setUrl] = useState(app.signalUrl);
  return (
    <div className="list">
      <Row
        title="Servidor de sinalização"
        desc="Serviço local que coordena hosts, convites e sessões. Por padrão ele roda junto com o app."
      >
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            app.setSignalUrl(url);
          }}
        >
          <input className="input mono" style={{ width: 230 }} value={url} onChange={(e) => setUrl(e.target.value)} aria-label="URL do servidor" />
          <button type="submit" className="btn">
            Aplicar
          </button>
        </form>
      </Row>
      <Row
        title="Relay TURN"
        desc={
          TURN_CONFIGURED
            ? `Usado quando não há caminho direto: ${TURN_SUMMARY}`
            : "Sem TURN, conexões atrás de NAT simétrico/CGNAT (comum em 4G e em alguns provedores) falham. Configure VITE_TURN_URLS, VITE_TURN_USERNAME e VITE_TURN_CREDENTIAL no .env."
        }
      >
        <Status tone={TURN_CONFIGURED ? "on" : "idle"}>{TURN_CONFIGURED ? "Configurado" : "Não configurado"}</Status>
      </Row>
      <Row
        title="Sinalização entre PCs"
        desc={
          CLOUD_CONFIGURED
            ? "Ofertas WebRTC são cifradas com a chave da sessão (AES-GCM) antes de passar pelo Supabase Realtime."
            : "Sem Supabase configurado, só é possível conectar janelas no mesmo PC."
        }
      >
        <Status tone={CLOUD_CONFIGURED ? "on" : "idle"}>{CLOUD_CONFIGURED ? "Nuvem, cifrada" : "Somente local"}</Status>
      </Row>
      {app.sysInfo ? (
        <Row title="Este PC na rede local">
          <span className="mono dim">{app.sysInfo.lanIp}</span>
        </Row>
      ) : null}
    </div>
  );
}

function AuthModal({ onClose, initialMode }: { onClose: () => void; initialMode: "login" | "signup" }) {
  const app = useApp();
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  return (
    <Modal
      title={mode === "login" ? "Entrar" : "Criar conta"}
      subtitle="A conta liga seus computadores entre si e permite adicionar amigos."
      onClose={onClose}
    >
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setLoading(true);
          setError(null);
          try {
            if (await app.signIn(mode, email.trim(), password, username)) onClose();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Falha na autenticação");
          } finally {
            setLoading(false);
          }
        }}
      >
        <Segmented
          label="Modo"
          value={mode}
          onChange={setMode}
          options={[
            { value: "login", label: "entrar" },
            { value: "signup", label: "criar conta" },
          ]}
        />
        {mode === "signup" ? (
          <div className="field">
            <label htmlFor="au-user">Nome de usuário</label>
            <input id="au-user" className="input" value={username} onChange={(e) => setUsername(e.target.value)} maxLength={32} />
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="au-mail">E-mail</label>
          <input id="au-mail" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="au-pass">Senha</label>
          <input
            id="au-pass"
            className="input"
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error ? <p style={{ color: "var(--red)", margin: 0, fontSize: 13 }}>{error}</p> : null}
        <div className="modal-actions">
          <button type="submit" className="btn primary" disabled={loading}>
            {mode === "login" ? "Entrar" : "Criar conta"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AccountTab() {
  const app = useApp();
  const [auth, setAuth] = useState<null | "login" | "signup">(null);
  const [username, setUsername] = useState(app.cloudProfile?.username ?? "");
  useEffect(() => setUsername(app.cloudProfile?.username ?? ""), [app.cloudProfile]);

  if (!CLOUD_CONFIGURED) {
    return (
      <div className="list">
        <Row title="Conta na nuvem indisponível" desc="Configure VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY no .env para ativar contas, amigos entre PCs e sinalização remota.">
          <Status>Somente local</Status>
        </Row>
      </div>
    );
  }

  return (
    <div className="list">
      {app.cloudProfile ? (
        <>
          <Row title={`${app.cloudProfile.username}#${app.cloudProfile.discriminator}`} desc={app.cloudProfile.email}>
            <button type="button" className="btn ghost" onClick={() => void app.signOut()}>
              <IconLogout size={15} /> Sair
            </button>
          </Row>
          <Row title="Nome de usuário" desc="Como seus amigos encontram você.">
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                void app.saveUsername(username);
              }}
            >
              <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} maxLength={32} aria-label="Nome de usuário" />
              <button type="submit" className="btn" disabled={!username.trim()}>
                Salvar
              </button>
            </form>
          </Row>
        </>
      ) : (
        <Row title="Você não está conectado" desc="Entre para ver seus outros computadores e os dos seus amigos.">
          <div className="row">
            <button type="button" className="btn ghost" onClick={() => setAuth("signup")}>
              Criar conta
            </button>
            <button type="button" className="btn primary" onClick={() => setAuth("login")}>
              Entrar
            </button>
          </div>
        </Row>
      )}
      <Row title="Projeto" desc={<span className="mono">{SUPABASE_URL}</span>}>
        <Status tone={app.signedIn ? "on" : "idle"}>{app.signedIn ? "Conectado" : "Sem conta"}</Status>
      </Row>
      {auth ? <AuthModal initialMode={auth} onClose={() => setAuth(null)} /> : null}
    </div>
  );
}

function AboutTab() {
  const app = useApp();
  const sys = app.sysInfo;
  return (
    <div className="stack">
      <div className="list">
        <Row title="PulseLink" desc="Acesso remoto P2P de baixa latência + integração com Moonlight/Sunshine.">
          <span className="mono dim">v{APP_VERSION}</span>
        </Row>
        {sys ? (
          <Row title="Sistema" desc={`${sys.cpuModel} · ${sys.cpuCores} núcleos · ${sys.totalMemGb} GB`}>
            <span className="mono dim">{sys.platform}</span>
          </Row>
        ) : null}
        <Row
          title="ID deste dispositivo"
          desc={app.backendKind === "cloud" ? "Outra forma de alguém adicionar você como amigo." : "Usado no modo local, sem conta."}
        >
          <span className="mono">{app.friendCode ?? "—"}</span>
        </Row>
      </div>
      <div className="list">
        <Row title="Sair da transmissão">
          <Kbd keys={["Ctrl", "Shift", "Q"]} />
        </Row>
        <Row title="Abrir/fechar chat">
          <Kbd keys={["Ctrl", "Shift", "C"]} />
        </Row>
        <Row title="Tela cheia">
          <Kbd keys={["Ctrl", "Shift", "F"]} />
        </Row>
        <Row title="Mostrar/ocultar controles">
          <Kbd keys={["Ctrl", "Shift", "M"]} />
        </Row>
      </div>
      {window.pulselinkDesktop && !app.isGuestWindow ? (
        <div className="list">
          <Row title="Janela de convidado de teste" desc="Abre uma segunda instância isolada para testar host e convidado no mesmo PC.">
            <button type="button" className="btn" onClick={() => void window.pulselinkDesktop?.openGuestWindow()}>
              Abrir
            </button>
          </Row>
        </div>
      ) : null}
    </div>
  );
}

export function SettingsView() {
  const app = useApp();
  return (
    <div className="page">
      <header className="page-header">
        <h1>Ajustes</h1>
      </header>
      <div className="settings">
        <nav className="settings-nav" aria-label="Seções">
          {TABS.map((t) => (
            <button key={t.id} type="button" className={app.settingsTab === t.id ? "on" : ""} onClick={() => app.setSettingsTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div>
          {app.settingsTab === "streaming" ? <StreamingTab /> : null}
          {app.settingsTab === "host" ? <HostTab /> : null}
          {app.settingsTab === "network" ? <NetworkTab /> : null}
          {app.settingsTab === "account" ? <AccountTab /> : null}
          {app.settingsTab === "about" ? <AboutTab /> : null}
        </div>
      </div>
    </div>
  );
}
