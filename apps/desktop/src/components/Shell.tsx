import type { ReactNode } from "react";
import { useApp, type View } from "../state/AppState";
import { CLOUD_CONFIGURED } from "../supabase";
import { IconGamepad, IconMonitor, IconPlay, IconSettings, IconUsers, PulseMark } from "./Icons";
import { Avatar } from "./ui";

export function TitleBar() {
  const app = useApp();
  const live = app.session?.status === "active";
  const signal = app.signalOk === null ? "" : app.signalOk ? "on" : "off";
  const cloud = !CLOUD_CONFIGURED ? "" : app.signedIn ? "on" : "warn";
  return (
    <header className="titlebar">
      <div className="wordmark">
        <PulseMark live={live} />
        PulseLink{app.isGuestWindow ? <span className="muted">convidado</span> : null}
      </div>
      <div className="conn" title={`Sinalização: ${app.signalUrl}`}>
        <span>
          <i className={`dot ${signal}`} />
          {app.signalOk === false ? "Serviço local parado" : "Serviço local"}
        </span>
        <span title={app.signedIn ? "Conectado à sua conta" : "Entre na sua conta para conectar PCs em redes diferentes"}>
          <i className={`dot ${cloud}`} />
          {!CLOUD_CONFIGURED ? "Somente local" : app.signedIn ? "Conta conectada" : "Sem conta"}
        </span>
      </div>
      <div className="win-controls">
        <button type="button" className="win-btn" onClick={() => void window.pulselinkDesktop?.minimize()} aria-label="Minimizar">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M1 5h8" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </button>
        <button type="button" className="win-btn" onClick={() => void window.pulselinkDesktop?.maximizeOrRestore()} aria-label="Maximizar">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </button>
        <button type="button" className="win-btn close" onClick={() => void window.pulselinkDesktop?.close()} aria-label="Fechar">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </button>
      </div>
    </header>
  );
}

function NavItem({ view, icon, label, extra }: { view: View; icon: ReactNode; label: string; extra?: ReactNode }) {
  const app = useApp();
  return (
    <button
      type="button"
      className={`nav-item ${app.view === view ? "active" : ""}`}
      onClick={() => app.setView(view)}
      title={label}
      aria-current={app.view === view ? "page" : undefined}
    >
      {icon}
      <span>{label}</span>
      {extra}
    </button>
  );
}

function IconPlayStation() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7" width="18" height="10" rx="2" />
      <path d="M7 12h4M17 11v2" />
    </svg>
  );
}

export function Sidebar() {
  const app = useApp();
  const name = app.cloudProfile?.username ?? app.deviceName;
  return (
    <nav className="sidebar" aria-label="Navegação">
      <NavItem view="computers" icon={<IconMonitor size={16} />} label="Computadores" />
      <NavItem
        view="friends"
        icon={<IconUsers size={16} />}
        label="Amigos"
        extra={app.pending.length > 0 ? <span className="nav-count">{app.pending.length}</span> : null}
      />
      <div className="nav-group">Jogos</div>
      <NavItem view="moonlight" icon={<IconGamepad size={16} />} label="Moonlight" />
      <NavItem view="playstation" icon={<IconPlayStation />} label="PlayStation" />
      {app.session ? (
        <>
          <div className="nav-group">Sessão</div>
          <NavItem
            view="stream"
            icon={<IconPlay size={16} />}
            label={app.isSessionHost ? "Hospedando" : "Conectado"}
            extra={app.session.status === "active" ? <i className="dot on" /> : null}
          />
        </>
      ) : null}

      <div className="sidebar-foot">
        <NavItem view="settings" icon={<IconSettings size={16} />} label="Ajustes" />
        <button
          type="button"
          className="me"
          onClick={() => {
            app.setSettingsTab("account");
            app.setView("settings");
          }}
        >
          <Avatar name={name} />
          <div style={{ minWidth: 0 }}>
            <div className="me-name">{name}</div>
            <div className="me-sub">
              {app.cloudProfile ? `#${app.cloudProfile.discriminator}` : "Sem conta"}
            </div>
          </div>
        </button>
      </div>
    </nav>
  );
}

export function Toasts() {
  const { toasts } = useApp();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === "error" ? "error" : ""}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

/** Incoming connection request, shown on the main pages while a guest is waiting. */
export function RequestNotice() {
  const app = useApp();
  const req = app.pending[0];
  if (!req) return null;
  const guest = req.participants.find((p) => p.role === "guest");
  return (
    <div className="notice request" role="alert">
      <Avatar name={guest?.displayName ?? "?"} />
      <div className="grow">
        <strong>{guest?.displayName ?? "Alguém"} quer se conectar</strong>
        <p>Entra só assistindo. Você libera teclado e mouse depois, se quiser.</p>
      </div>
      <button type="button" className="btn ghost" disabled={app.busy} onClick={() => void app.deny(req.session.id)}>
        Recusar
      </button>
      <button type="button" className="btn primary" disabled={app.busy} onClick={() => void app.approve(req.session.id)}>
        Aceitar
      </button>
    </div>
  );
}
