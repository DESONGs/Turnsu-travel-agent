const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const apiArgument = process.argv.find((value) => value.startsWith("--travel-api-origin="));
const apiBaseUrl = apiArgument?.slice("--travel-api-origin=".length) ?? "";

contextBridge.exposeInMainWorld("travelDesktop", Object.freeze({
  runtimeConfig: Object.freeze({ desktop: true, apiBaseUrl }),
  restoreSession: () => ipcRenderer.invoke("desktop:session-restore"),
  saveSession: (token: string) => ipcRenderer.invoke("desktop:session-save", token),
  clearSession: () => ipcRenderer.invoke("desktop:session-clear"),
  beginOAuth: (provider: string, returnTo = "/", link?: string) => ipcRenderer.invoke("desktop:oauth-begin", { provider, returnTo, link }),
  openEvidenceSource: (url: string) => ipcRenderer.invoke("desktop:evidence-open", { url }),
  closeEvidenceSource: () => ipcRenderer.invoke("desktop:evidence-close"),
  captureEvidence: () => ipcRenderer.invoke("desktop:evidence-capture"),
  openExternal: (url: string) => ipcRenderer.invoke("desktop:external-open", { url }),
  takePendingAuthCallback: () => ipcRenderer.invoke("desktop:auth-take-pending"),
  onAuthCallback: (listener: (payload: unknown) => void) => {
    const handler = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on("desktop:auth-callback", handler);
    return () => ipcRenderer.removeListener("desktop:auth-callback", handler);
  },
  onEvidenceState: (listener: (payload: unknown) => void) => {
    const handler = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on("desktop:evidence-state", handler);
    return () => ipcRenderer.removeListener("desktop:evidence-state", handler);
  },
}));
