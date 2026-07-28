import electron from "electron";
import type { RuntimeHealth, RuntimeLogEntry, RuntimeStatus } from "../main/runtime.js";

const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld("workflowRuntime", {
  health: (): Promise<RuntimeHealth> =>
    ipcRenderer.invoke("runtime:health") as Promise<RuntimeHealth>,
  status: (): Promise<RuntimeStatus> =>
    ipcRenderer.invoke("runtime:status") as Promise<RuntimeStatus>,
  restart: (): Promise<RuntimeStatus> =>
    ipcRenderer.invoke("runtime:restart") as Promise<RuntimeStatus>,
  logs: (): Promise<RuntimeLogEntry[]> =>
    ipcRenderer.invoke("runtime:logs") as Promise<RuntimeLogEntry[]>
});
