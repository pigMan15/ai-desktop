import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("workflowRuntime", {
  health: () => ipcRenderer.invoke("runtime:health")
});
