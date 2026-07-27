import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("workflowPlatform", {
  version: "0.1.0"
});
