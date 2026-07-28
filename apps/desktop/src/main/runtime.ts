import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export type RuntimeHealth = {
  status: "ok";
  service: "workflow-runtime";
};

export type RuntimeStatus = {
  mode: "external" | "managed";
  state: "stopped" | "starting" | "ready" | "failed";
  url: string;
  port: number;
  pid: number | null;
  lastError: string | null;
};

export type RuntimeLogEntry = {
  level: "info" | "error";
  message: string;
  createdAt: string;
};

type RuntimeProcess = EventEmitter & {
  pid?: number;
  stdout?: EventEmitter;
  stderr?: EventEmitter;
  kill(signal?: NodeJS.Signals): void;
};

type SpawnProcess = (
  command: string,
  args: string[],
  options: { cwd?: string; windowsHide: boolean; env: NodeJS.ProcessEnv },
) => RuntimeProcess;

type ManagedRuntimeOptions = {
  externalUrl?: string;
  port?: number;
  host?: string;
  cwd?: string;
  pythonCommand?: string;
  spawnProcess?: SpawnProcess;
  healthCheck?: (url: string) => Promise<RuntimeHealth>;
  env?: NodeJS.ProcessEnv;
};

export function runtimeHealth(): RuntimeHealth {
  return { status: "ok", service: "workflow-runtime" };
}

export class ManagedRuntime {
  private readonly externalUrl?: string;
  private readonly host: string;
  private readonly portValue: number;
  private readonly cwdValue?: string;
  private readonly pythonCommand: string;
  private readonly spawnProcess: SpawnProcess;
  private readonly healthCheck: (url: string) => Promise<RuntimeHealth>;
  private readonly env: NodeJS.ProcessEnv;
  private process: RuntimeProcess | null = null;
  private state: RuntimeStatus["state"] = "stopped";
  private lastError: string | null = null;
  private readonly logEntries: RuntimeLogEntry[] = [];
  private restartAttempted = false;

  constructor(options: ManagedRuntimeOptions = {}) {
    this.externalUrl = options.externalUrl;
    this.host = options.host ?? "127.0.0.1";
    this.portValue = options.port ?? 8765;
    this.cwdValue = options.cwd;
    this.pythonCommand =
      options.pythonCommand ?? (process.platform === "win32" ? "python.exe" : "python");
    this.spawnProcess =
      options.spawnProcess ??
      ((command, args, spawnOptions) =>
        spawn(command, args, {
          cwd: spawnOptions.cwd,
          env: spawnOptions.env,
          windowsHide: spawnOptions.windowsHide,
          stdio: ["ignore", "pipe", "pipe"],
        }) as RuntimeProcess);
    this.healthCheck = options.healthCheck ?? fetchRuntimeHealth;
    this.env = options.env ?? process.env;
  }

  async start(): Promise<RuntimeStatus> {
    if (this.state === "ready" || this.state === "starting") {
      return this.status();
    }

    this.state = "starting";
    this.lastError = null;

    if (!this.externalUrl) {
      this.process = this.spawnProcess(this.pythonCommand, this.runtimeArgs(), {
        cwd: this.cwdValue,
        windowsHide: true,
        env: this.env,
      });
      this.attachProcessListeners(this.process);
    }

    try {
      await this.healthCheck(this.url());
      this.state = "ready";
    } catch (error) {
      this.state = "failed";
      this.lastError = error instanceof Error ? error.message : String(error);
      this.pushLog("error", this.lastError);
    }

    return this.status();
  }

  async stop(): Promise<RuntimeStatus> {
    this.restartAttempted = true;
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.state = "stopped";
    return this.status();
  }

  async restart(): Promise<RuntimeStatus> {
    await this.stop();
    this.restartAttempted = false;
    return this.start();
  }

  status(): RuntimeStatus {
    return {
      mode: this.externalUrl ? "external" : "managed",
      state: this.state,
      url: this.url(),
      port: this.portValue,
      pid: this.process?.pid ?? null,
      lastError: this.lastError,
    };
  }

  logs(): RuntimeLogEntry[] {
    return [...this.logEntries];
  }

  private runtimeArgs(): string[] {
    return [
      "-m",
      "uvicorn",
      "workflow_platform.api.app:create_runtime_app",
      "--factory",
      "--host",
      this.host,
      "--port",
      String(this.portValue),
    ];
  }

  private attachProcessListeners(runtimeProcess: RuntimeProcess): void {
    runtimeProcess.stdout?.on("data", (chunk) => this.pushLog("info", String(chunk).trim()));
    runtimeProcess.stderr?.on("data", (chunk) => this.pushLog("error", String(chunk).trim()));
    runtimeProcess.on("exit", () => {
      this.process = null;
      if (this.state !== "stopped") {
        this.state = "failed";
        this.lastError = "Runtime process exited";
        if (!this.restartAttempted) {
          this.restartAttempted = true;
          void this.start();
        }
      }
    });
  }

  private pushLog(level: RuntimeLogEntry["level"], message: string): void {
    if (!message) {
      return;
    }
    this.logEntries.push({ level, message, createdAt: new Date().toISOString() });
    if (this.logEntries.length > 200) {
      this.logEntries.shift();
    }
  }

  private url(): string {
    return this.externalUrl ?? `http://${this.host}:${this.portValue}`;
  }
}

async function fetchRuntimeHealth(url: string): Promise<RuntimeHealth> {
  const response = await fetch(`${url}/health`);
  if (!response.ok) {
    throw new Error(`Runtime health failed with ${response.status}`);
  }
  return (await response.json()) as RuntimeHealth;
}
