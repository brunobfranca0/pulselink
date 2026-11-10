import { useState } from "react";
import { RequestNotice } from "../components/Shell";
import { Avatar, PermissionToggles, Status, Switch } from "../components/ui";
import { useApp } from "../state/AppState";

export function FriendsView() {
  const app = useApp();
  const [input, setInput] = useState("");

  return (
    <div className="page">
      <header className="page-header">
        <div className="grow">
          <h1>Amigos</h1>
          <p className="subtitle">
            Quem você adiciona passa a ver seus computadores e pedir para se conectar. Aqui você define o que cada um pode fazer.
          </p>
        </div>
      </header>

      <RequestNotice />

      <form
        className="add-inline"
        style={{ marginTop: 0 }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (input.trim() && (await app.addFriend(input))) setInput("");
        }}
      >
        <input
          className="input"
          placeholder="usuario#1234 ou ID do dispositivo…"
          spellCheck={false}
          autoComplete="off"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label="Usuário ou ID do dispositivo"
        />
        <button type="submit" className="btn primary" disabled={!input.trim() || app.busy}>
          Adicionar
        </button>
      </form>

      <section className="block" style={{ marginTop: 24 }}>
        <div className="block-head">
          <h2 className="block-title">Amigos</h2>
          <span className="muted" style={{ fontSize: 12 }}>
            Permissões padrão · Entrar sem pedir
          </span>
        </div>
        <div className="list">
          {app.friends.map((f) => (
            <div key={f.id} className="list-row">
              <Avatar name={f.friendName} />
              <div className="grow">
                <div className="row-title">
                  {f.friendName}
                  <span className="muted mono" style={{ fontWeight: 400 }}>
                    {f.friendTag}
                  </span>
                </div>
                <div className="row-meta">{f.online ? <Status tone="on">Online</Status> : f.statusText}</div>
              </div>
              <PermissionToggles perms={f} onToggle={(k) => void app.updateFriend(f, { [k]: !f[k] })} />
              <Switch
                label={`${f.friendName} entra sem pedir aprovação`}
                checked={f.autoConnect}
                onChange={(v) => void app.updateFriend(f, { autoConnect: v })}
              />
              <button type="button" className="btn ghost sm" onClick={() => {
                  if (window.confirm(`Remover ${f.friendName} dos seus amigos?`)) void app.removeFriend(f);
                }}>
                Remover
              </button>
            </div>
          ))}
          {app.friends.length === 0 ? (
            <div className="list-empty">
              Você ainda não adicionou ninguém. O ID do dispositivo aparece no canto inferior esquerdo do app do seu amigo.
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
