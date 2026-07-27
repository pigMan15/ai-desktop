import assert from "node:assert/strict";
import { registerRuntimeHandlers } from "../src/main/main.js";

const registeredChannels: string[] = [];
const fakeIpcMain = {
  handle(channel: string, handler: () => unknown) {
    registeredChannels.push(channel);
    assert.deepEqual(handler(), {
      status: "ok",
      service: "workflow-runtime"
    });
  }
};

registerRuntimeHandlers(fakeIpcMain);
registerRuntimeHandlers(fakeIpcMain);

assert.deepEqual(registeredChannels, ["runtime:health"]);
