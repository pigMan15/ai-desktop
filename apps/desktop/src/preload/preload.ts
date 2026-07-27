import electron from "electron";
import type { RuntimeHealth } from "../main/runtime.js";

const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld("workflowRuntime", {
  health: (): Promise<RuntimeHealth> =>
    ipcRenderer.invoke("runtime:health") as Promise<RuntimeHealth>
});
