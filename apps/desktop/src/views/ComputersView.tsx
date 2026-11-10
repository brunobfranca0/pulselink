import { useState } from "react";
import type { Host } from "@pulselink/protocol";
import { IconCopy, IconMonitor, IconRefresh } from "../components/Icons";
import { RequestNotice } from "../components/Shell";
import { Avatar, PermissionToggles, Status, Switch } from "../components/ui";
import { useApp } from "../state/AppState";

function timeLeft(iso: string) {
  const m = Math.round((Date.parse(iso) - Date.now()) / 60000);
  if (m <= 0) return "expirado";
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

function ThisComputer() {
  const app = useApp();
  const online = app.myHost?.status === "online";
  const source = app.captureSources.find((s) => s.id === app.selectedSourceId) ?? app.captureSources[0];
  const display = app.displays.find((d) => d.isPrimary) ?? app.displays[0];

  return (
    <div className="this-pc">
      <div className="thumb">
        {source?.thumbnailDataUrl ? <img src={source.thumbnailDataUrl} alt="" width={176} height={110} /> : <IconMonitor size={28} />}
      </div>
      <div className="this-pc-body">
        <div className="this-pc-title">
          <h3>{app.myHost?.name ?? app.deviceName}</h3>
          <Status tone={online ? "on" : undefined}>{online ? "Disponível" : "Não disponível"}</Status>
          <div className="grow" />
          <label className="inline-toggle">
            Permitir conexões
            <Switch label="Permitir conexões" checked={online} disabled={app.busy} onChange={(on) => void app.setHosting(on)} />
          </label>
        </div>
        <div className="facts">
          {display ? (
            <span>
              <b>{display.width}×{display.height}</b> {display.refreshRate} Hz
            </span>
          ) : null}
          <span>
            Transmite em <b>{app.streamProfile.resolution.replace("x", "×")}</b>, {app.streamProfile.fps} fps
          </span>
          {app.sysInfo ? <span className="mono">{app.sysInfo.lanIp}</span> : null}
        </div>

        {app.invite ? (
          <div className="code-box">
            <span className="code">{app.invite.code}</span>
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                void navigator.clipboard.writeText(app.invite!.code);
                app.notify("Código copiado");
              }}
            >
              <IconCopy size={13} /> Copiar
            </button>
            <span className="muted">expira em {timeLeft(app.invite.expiresAt)}</span>
          </div>
        ) : null}

        <div className="row">
          <button type="button" className="btn" disabled={app.busy} onClick={() => void app.createShareLink()}>
            {app.invite ? "Gerar outro código" : "Gerar código de acesso"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectedGuests() {
  const app = useApp();
  if (!app.isSessionHost || app.guests.length === 0) return null;
  return (
    <section className="block">
      <h2 className="block-title">Conectados a este computador</h2>
      <div className="list">
        {app.guests.map((g) => (
          <div key={g.id} className="list-row">
            <Avatar name={g.displayName} />
            <div className="grow row-title">{g.displayName}</div>
            <PermissionToggles perms={g.permissions} onToggle={(k) => void app.togglePermission(g, k)} />
            <button type="button" className="btn ghost sm" onClick={() => void app.kick(g)}>
              Desconectar
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function HostRow({ host }: { host: Host }) {
  const app = useApp();
  const online = host.status === "online";
  return (
    <div className="list-row">
      <div className="machine-glyph">
        <IconMonitor size={17} />
      </div>
      <div className="grow">
        <div className="row-title">{host.name}</div>
        <div className="row-meta">{host.ownerDisplayName ?? "Amigo"}</div>
      </div>
      <Status tone={online ? "on" : host.status === "busy" ? "idle" : undefined}>
        {online ? "Online" : host.status === "busy" ? "Ocupado" : "Offline"}
      </Status>
      <button type="button" className="btn" disabled={!online || app.busy} onClick={() => void app.connectToHost(host)}>
        Conectar
      </button>
    </div>
  );
}

export function ComputersView() {
  const app = useApp();
  const [code, setCode] = useState("");

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="grow">Computadores</h1>
        <button type="button" className="btn ghost icon" onClick={() => void app.refreshAll()} aria-label="Atualizar" title="Atualizar">
          <IconRefresh size={15} />
        </button>
      </header>

      {app.signalOk === false ? (
        <div className="notice error">
          <div className="grow">
            <strong>O serviço local não está respondendo</strong>
            <p>Reinicie o PulseLink. Se o problema continuar, confira a URL em Ajustes › Rede.</p>
          </div>
        </div>
      ) : null}

      <RequestNotice />

      <section className="block">
        <h2 className="block-title">Este computador</h2>
        <ThisComputer />
      </section>

      <ConnectedGuests />

      <section className="block">
        <h2 className="block-title">Conectar a outro computador</h2>
        <form
          className="join"
          onSubmit={async (e) => {
            e.preventDefault();
            if (code.trim() && (await app.joinWithCode(code))) setCode("");
          }}
        >
          <input
            className="input"
            placeholder="Ex.: 03CEA512…"
            spellCheck={false}
            autoComplete="off"
            value={code}
            maxLength={40}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            aria-label="Código de acesso"
          />
          <button type="submit" className="btn primary" disabled={app.busy || !code.trim()}>
            Conectar
          </button>
        </form>
      </section>

      <section className="block">
        <h2 className="block-title">Seus computadores e de amigos</h2>
        <div className="list">
          {app.availableHosts.map((h) => (
            <HostRow key={h.id} host={h} />
          ))}
          {app.availableHosts.length === 0 ? (
            <div className="list-empty">
              {app.backendKind === "cloud" ? (
                <>
                  Nenhum por enquanto. Aparecem aqui seus outros PCs com o PulseLink aberto na mesma conta e os PCs de quem
                  adicionou você como amigo.
                </>
              ) : (
                <>
                  Sem conta, só aparecem PCs desta rede. Para conectar a qualquer lugar,{" "}
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      app.setSettingsTab("account");
                      app.setView("settings");
                    }}
                  >
                    entre na sua conta
                  </button>
                  .
                </>
              )}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
