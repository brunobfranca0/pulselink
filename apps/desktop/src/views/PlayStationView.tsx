import { useEffect, useState } from "react";
import type { PlayStationConsole } from "@pulselink/protocol";
import { IconPlay, IconPlus, IconRefresh, IconX } from "../components/Icons";
import { Switch } from "../components/ui";
import { useApp } from "../state/AppState";

const STATE_LABEL: Record<PlayStationConsole["state"], string> = {
  ready: "Ligado",
  standby: "Em repouso",
  unknown: "Desconhecido",
};

function formatFirmware(v: string | null) {
  // "13520001" → "13.52"
  if (!v || !/^\d{8}$/.test(v)) return v;
  return `${Number(v.slice(0, 2))}.${v.slice(2, 4)}`;
}

function SetupSteps() {
  const app = useApp();
  const client = app.psClient;
  const installed = !!client?.installed;
  const anyRegistered = (client?.registered.length ?? 0) > 0;
  return (
    <section className="block">
      <h2 className="block-title">Configuração</h2>
      <ol className="checklist">
        <li className={installed ? "done" : ""}>
          <div className="grow">
            <strong>Instale o chiaki-ng</strong>
            <p>Cliente open source de Remote Play para PS4 e PS5. O PulseLink o usa para transmitir.</p>
          </div>
          {installed ? (
            <span className="muted mono">instalado</span>
          ) : (
            <button type="button" className="btn" onClick={() => client && void window.pulselinkDesktop?.openExternal(client.downloadUrl)}>
              Baixar
            </button>
          )}
        </li>
        <li className={anyRegistered ? "done" : ""}>
          <div className="grow">
            <strong>Registre o console uma vez</strong>
            <p>
              No console: Configurações › Configurações de conexão do Uso Remoto › Adicionar dispositivo. Digite o PIN no chiaki-ng
              junto com o ID da sua conta PSN.
            </p>
          </div>
          {anyRegistered ? (
            <span className="muted mono">{client!.registered.join(", ")}</span>
          ) : (
            <button type="button" className="btn" disabled={!installed || app.busy} onClick={() => void app.playstation.openClient()}>
              Abrir chiaki-ng
            </button>
          )}
        </li>
        <li>
          <div className="grow">
            <strong>Ative o Uso Remoto no console</strong>
            <p>Configurações › Configurações de conexão do Uso Remoto › Ativar Uso Remoto. Para ligar o console à distância, ative também o modo de repouso com conexão à internet.</p>
          </div>
        </li>
      </ol>
    </section>
  );
}

function ConsoleRow({ c, fullscreen }: { c: PlayStationConsole; fullscreen: boolean }) {
  const app = useApp();
  const installed = !!app.psClient?.installed;
  const canPlay = installed && c.registered && c.state !== "unknown";
  return (
    <div className="list-row">
      <div className={`console-glyph ${c.type === "PS5" ? "ps5" : ""}`}>{c.type}</div>
      <div className="grow">
        <div className="row-title">
          {c.name}
          <span className={`status ${c.state === "ready" ? "on" : c.state === "standby" ? "idle" : ""}`}>{STATE_LABEL[c.state]}</span>
        </div>
        <div className="row-meta mono">
          {c.address}
          {c.systemVersion ? ` · firmware ${formatFirmware(c.systemVersion)}` : ""}
          {c.runningApp ? ` · ${c.runningApp}` : ""}
        </div>
      </div>
      {!c.registered && installed ? <span className="muted">Não registrado</span> : null}
      {c.state === "standby" && canPlay ? (
        // Waking a console needs its registration key, which lives in chiaki-ng: let it do the wake.
        <button type="button" className="btn" disabled={app.busy} onClick={() => void app.playstation.openClient()} title="O chiaki-ng liga o console e conecta">
          Ligar pelo chiaki-ng
        </button>
      ) : (
        <button
          type="button"
          className="btn primary"
          disabled={!canPlay || app.busy}
          title={!installed ? "Instale o chiaki-ng" : !c.registered ? "Registre este console no chiaki-ng" : undefined}
          onClick={() => void app.playstation.launch(c, fullscreen)}
        >
          <IconPlay size={14} /> Jogar
        </button>
      )}
    </div>
  );
}

export function PlayStationView() {
  const app = useApp();
  const [address, setAddress] = useState("");
  const [fullscreen, setFullscreen] = useState(true);

  useEffect(() => {
    void app.playstation.discover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="page">
      <header className="page-header">
        <div className="grow">
          <h1>PlayStation</h1>
          <p className="subtitle">Jogue no seu PS4 ou PS5 pelo Remote Play.</p>
        </div>
        <button type="button" className="btn" disabled={app.psScanning} onClick={() => void app.playstation.discover()}>
          <IconRefresh size={14} /> {app.psScanning ? "Procurando…" : "Procurar"}
        </button>
      </header>

      <section className="block">
        <div className="block-head">
          <h2 className="block-title">Consoles na rede</h2>
          <label className="inline-toggle">
            Tela cheia
            <Switch label="Abrir em tela cheia" checked={fullscreen} onChange={setFullscreen} />
          </label>
        </div>
        <div className="list">
          {app.psConsoles.map((c) => (
            <ConsoleRow key={c.hostId} c={c} fullscreen={fullscreen} />
          ))}
          {app.psConsoles.length === 0 ? (
            <div className="list-empty">
              {app.psScanning
                ? "Procurando consoles…"
                : "Nenhum console respondeu. Confira se ele está ligado ou em repouso e na mesma rede, ou adicione o IP abaixo."}
            </div>
          ) : null}
        </div>

        <form
          className="add-inline"
          onSubmit={(e) => {
            e.preventDefault();
            if (!address.trim()) return;
            app.playstation.addAddress(address);
            void app.playstation.discover([...app.psAddresses, address.trim()]);
            setAddress("");
          }}
        >
          <input
            className="input mono"
            placeholder="IP do console, ex.: 192.168.0.176…"
            spellCheck={false}
            autoComplete="off"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            aria-label="IP do console"
          />
          <button type="submit" className="btn" disabled={!address.trim()}>
            <IconPlus size={14} /> Adicionar
          </button>
        </form>
        {app.psAddresses.length ? (
          <div className="tags">
            {app.psAddresses.map((a) => (
              <span key={a} className="tag mono">
                {a}
                <button type="button" aria-label={`Remover ${a}`} onClick={() => app.playstation.removeAddress(a)}>
                  <IconX size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </section>

      <SetupSteps />

      <p className="footnote">
        Fora de casa: o chiaki-ng conecta pela PSN sem abrir portas. Abra-o e use a opção remota dele. O PulseLink cuida da rede
        local.
      </p>
    </div>
  );
}
