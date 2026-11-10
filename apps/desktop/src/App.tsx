import { Sidebar, TitleBar, Toasts } from "./components/Shell";
import { AppStateProvider, useApp } from "./state/AppState";
import { ComputersView } from "./views/ComputersView";
import { FriendsView } from "./views/FriendsView";
import { MoonlightView } from "./views/MoonlightView";
import { PlayStationView } from "./views/PlayStationView";
import { SettingsView } from "./views/SettingsView";
import { StreamView } from "./views/StreamView";

function Main() {
  const { view } = useApp();
  return (
    <main className={`main ${view === "stream" ? "flush" : ""}`}>
      {view === "computers" ? <ComputersView /> : null}
      {view === "moonlight" ? <MoonlightView /> : null}
      {view === "playstation" ? <PlayStationView /> : null}
      {view === "friends" ? <FriendsView /> : null}
      {view === "stream" ? <StreamView /> : null}
      {view === "settings" ? <SettingsView /> : null}
    </main>
  );
}

export function App() {
  return (
    <AppStateProvider>
      <div className="app">
        <TitleBar />
        <div className="body">
          <Sidebar />
          <Main />
        </div>
        <Toasts />
      </div>
    </AppStateProvider>
  );
}
