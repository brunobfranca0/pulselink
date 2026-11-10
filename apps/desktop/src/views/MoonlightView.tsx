import { useEffect, useState } from "react";
import type { MoonlightHost } from "@pulselink/protocol";
import { IconGamepad, IconPlay, IconRefresh, IconTrash } from "../components/Icons";
import { Modal, Spinner, Status } from "../components/ui";
import { useApp } from "../state/AppState";

function AddHostModal({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [port, setPort] = useState("47989");
  return (
    <Modal title="Adicionar host" subtitle="IP ou nome do computador que roda o Sunshine." onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await app.moonlight.add(address.trim(), name.trim() || undefined, Number(port) || undefined)) onClose();
        }}
      >
        <div className="field">
          <label htmlFor="ml-addr">Endereço</label>
          <input id="ml-addr" className="input mono" placeholder="192.168.0.20…" spellCheck={false} autoComplete="off" value={address} onChange={(e) => setAddress(e.target.value)} autoFocus />
        </div>
        <div className="row">
          <div className="field grow">
            <label htmlFor="ml-name">Nome (opcional)</label>
            <input id="ml-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field" style={{ width: 96 }}>
            <label htmlFor="ml-port">Porta</label>
            <input id="ml-port" className="input mono" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={!address.trim() || app.busy}>
            Adicionar
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PairModal({ host, onClose }: { host: MoonlightHost; onClose: () => void }) {
  const app = useApp();
  const [current, setCurrent] = useState(host);

  // Poll until the Moonlight client reports the pairing finished (or failed).
  useEffect(() => {
    const t = setInterval(async () => {
      const h = await app.moonlight.poll(host.id);
      if (!h) return;
      setCurrent(h);
      if (h.paired && h.pairingState === "idle") {
        app.notify(`Pareado com ${h.name}`);
        onClose();
      }
    }, 1500);
    return () => clearInterval(t);
  }, [app.moonlight, app.notify, host.id, onClose]);

  const cancel = () => {
    void app.moonlight.cancelPair(current);
    onClose();
  };
  const webUi = `https://${current.address}:47990`;

  return (
    <Modal title={`Parear com ${current.name}`} onClose={cancel}>
      {current.pairingState === "failed" ? (
        <div className="notice error" style={{ marginBottom: 0 }}>
          <div className="grow">
            <strong>O pareamento não foi concluído</strong>
            <p>{current.lastError}</p>
          </div>
          <button type="button" className="btn" onClick={() => void app.moonlight.pair(current).then((h) => h && setCurrent(h))}>
            Tentar de novo
          </button>
        </div>
      ) : (
        <>
          <div className="pin" aria-label={`PIN ${current.pendingPin ?? ""}`}>
            {current.pendingPin ?? "····"}
          </div>
          <ol className="steps">
            <li>
              No computador host, abra o Sunshine em{" "}
              <button type="button" className="link mono" onClick={() => void window.pulselinkDesktop?.openExternal(webUi)}>
                {webUi}
              </button>
            </li>
            <li>Na aba PIN, digite o código acima.</li>
          </ol>
          <div className="row" style={{ marginTop: 16, color: "var(--text-3)" }}>
            <Spinner /> Aguardando confirmação do Sunshine…
          </div>
        </>
      )}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={cancel}>
          Cancelar
        </button>
      </div>
    </Modal>
  );
}

function HostRow({ host, onPair }: { host: MoonlightHost; onPair: (h: MoonlightHost) => void }) {
  const app = useApp();
  const online = host.status === "online";
  const apps = host.apps.length ? host.apps : [{ id: "Desktop", title: "Desktop", hdrSupported: false }];
  const meta = [`${host.address}:${host.port}`, host.hostVersion && `Sunshine ${host.hostVersion}`, host.gpuModel]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <div className="list-row">
        <div className="machine-glyph">
          <IconGamepad size={17} />
        </div>
        <div className="grow">
          <div className="row-title">
            {host.name}
            <Status tone={online ? "on" : undefined}>{online ? "Online" : "Offline"}</Status>
          </div>
          <div className="row-meta mono">{meta}</div>
        </div>
        {!online && host.macAddress ? (
          <button type="button" className="btn" disabled={app.busy} onClick={() => void app.moonlight.wake(host)}>
            Ligar
          </button>
        ) : null}
        {host.paired ? (
          <button type="button" className="btn ghost icon" title="Atualizar lista de apps" aria-label="Atualizar apps" onClick={() => void app.moonlight.refreshApps(host)}>
            <IconRefresh size={14} />
          </button>
        ) : (
          <button type="button" className="btn primary" disabled={!online || app.busy || !app.moonlightClient?.installed} onClick={() => onPair(host)}>
            Parear
          </button>
        )}
        <button type="button" className="btn ghost icon" title="Remover" aria-label="Remover host" onClick={() => {
            if (window.confirm(`Remover ${host.name} da lista?`)) void app.moonlight.remove(host);
          }}>
          <IconTrash size={14} />
        </button>
      </div>
      {host.paired ? (
        <div className="apps">
          {apps.map((a) => (
            <button key={a.id} type="button" className="btn sm" disabled={app.busy} onClick={() => void app.moonlight.launch(host, a.title)}>
              <IconPlay size={12} /> {a.title}
            </button>
          ))}
          <button type="button" className="btn ghost sm" onClick={() => void app.moonlight.unpair(host)}>
            Desfazer pareamento
          </button>
        </div>
      ) : null}
    </>
  );
}

export function MoonlightView() {
  const app = useApp();
  const [adding, setAdding] = useState(false);
  const [pairing, setPairing] = useState<MoonlightHost | null>(null);
  const client = app.moonlightClient;

  return (
    <div className="page">
      <header className="page-header">
        <div className="grow">
          <h1>Moonlight</h1>
          <p className="subtitle">Jogue em PCs com Sunshine usando o cliente Moonlight.</p>
        </div>
        <button type="button" className="btn" disabled={app.busy} onClick={() => void app.moonlight.scan()}>
          <IconRefresh size={14} /> Procurar
        </button>
        <button type="button" className="btn" onClick={() => setAdding(true)}>
          Adicionar por IP
        </button>
      </header>

      {client && !client.installed ? (
        <div className="notice warn">
          <div className="grow">
            <strong>Moonlight não está instalado</strong>
            <p>É gratuito e open source. Se estiver em outra pasta, defina MOONLIGHT_PATH no .env.</p>
          </div>
          <button type="button" className="btn" onClick={() => void window.pulselinkDesktop?.openExternal(client.downloadUrl)}>
            Baixar
          </button>
        </div>
      ) : null}

      <section className="block">
        <h2 className="block-title">Hosts</h2>
        <div className="list">
          {app.moonlightHosts.map((h) => (
            <HostRow
              key={h.id}
              host={h}
              onPair={(x) => void app.moonlight.pair(x).then((started) => started && setPairing(started))}
            />
          ))}
          {app.moonlightHosts.length === 0 ? (
            <div className="list-empty">
              Nenhum host ainda. Use Procurar para encontrar computadores com{" "}
              <button type="button" className="link" onClick={() => void window.pulselinkDesktop?.openExternal("https://github.com/LizardByte/Sunshine")}>
                Sunshine
              </button>{" "}
              na rede, ou adicione pelo IP.
            </div>
          ) : null}
        </div>
      </section>

      <p className="footnote">
        A transmissão abre no Moonlight com {app.streamProfile.resolution.replace("x", "×")}, {app.streamProfile.fps} fps e{" "}
        {app.streamProfile.bitrateMbps} Mbps, definidos em Ajustes › Transmissão.
      </p>

      {adding ? <AddHostModal onClose={() => setAdding(false)} /> : null}
      {pairing ? <PairModal host={pairing} onClose={() => setPairing(null)} /> : null}
    </div>
  );
}
