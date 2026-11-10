const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pulselinkDesktop", {
  isDesktopApp: true,
  minimize: () => ipcRenderer.invoke("window:minimize"),
  maximizeOrRestore: () => ipcRenderer.invoke("window:maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  toggleFullScreen: () => ipcRenderer.invoke("window:fullscreen"),
  isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  openGuestWindow: () => ipcRenderer.invoke("window:open-guest"),
  getSystemInfo: () => ipcRenderer.invoke("system:info"),
  getDisplays: () => ipcRenderer.invoke("desktop:displays"),
  getCaptureSources: () => ipcRenderer.invoke("desktop:sources"),
  selectCaptureSource: (sourceId) => ipcRenderer.invoke("desktop:select-source", sourceId),
  setRemoteInputEnabled: (enabled) => ipcRenderer.invoke("input:set-enabled", !!enabled),
  injectInput: (payload) => ipcRenderer.send("input:inject", payload),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  onWindowStateChange: (cb) => {
    const handler = (_event, state) => cb(state);
    ipcRenderer.on("window:state", handler);
    return () => ipcRenderer.removeListener("window:state", handler);
  },
});
