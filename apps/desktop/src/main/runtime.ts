import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
  runtimeExecutablePath?: string;
  port?: number;
  host?: string;
  cwd?: string;
  pythonCommand?: string;
  spawnProcess?: SpawnProcess;
  healthCheck?: (url: string) => Promise<RuntimeHealth>;
  healthRetryAttempts?: number;
  healthRetryDelayMs?: number;
  env?: NodeJS.ProcessEnv;
  runtimeToken?: string;
};

export type RuntimeRequestOptions = {
  path: string;
  body?: unknown;
};

export function runtimeHealth(): RuntimeHealth {
  return { status: "ok", service: "workflow-runtime" };
}

export class ManagedRuntime {
  private readonly externalUrl?: string;
  private readonly runtimeExecutablePath?: string;
  private readonly host: string;
  private readonly portValue: number;
  private readonly cwdValue?: string;
  private readonly pythonCommand: string;
  private readonly spawnProcess: SpawnProcess;
  private readonly healthCheck: (url: string) => Promise<RuntimeHealth>;
  private readonly healthRetryAttempts: number;
  private readonly healthRetryDelayMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly runtimeToken?: string;
  private process: RuntimeProcess | null = null;
  private state: RuntimeStatus["state"] = "stopped";
  private lastError: string | null = null;
  private readonly logEntries: RuntimeLogEntry[] = [];
  private restartAttempted = false;

  constructor(options: ManagedRuntimeOptions = {}) {
    this.externalUrl = options.externalUrl?.trim() || undefined;
    this.runtimeExecutablePath = options.runtimeExecutablePath;
    this.host = options.host ?? "127.0.0.1";
    this.env = options.env ?? process.env;
    this.runtimeToken = this.externalUrl
      ? undefined
      : options.runtimeToken?.trim() || randomBytes(32).toString("base64url");
    this.portValue = options.port ?? runtimePortFromEnvironment(this.env);
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
    this.healthRetryAttempts = Math.max(1, options.healthRetryAttempts ?? 20);
    this.healthRetryDelayMs = Math.max(0, options.healthRetryDelayMs ?? 250);
  }

  async start(): Promise<RuntimeStatus> {
    if (this.state === "ready" || this.state === "starting") {
      return this.status();
    }

    this.state = "starting";
    this.lastError = null;

    if (!this.externalUrl) {
      this.process = this.spawnProcess(this.runtimeCommand(), this.runtimeArgs(), {
        cwd: this.cwdValue,
        windowsHide: true,
        env: this.runtimeEnvironment(),
      });
      this.attachProcessListeners(this.process);
    }

    try {
      await this.waitForHealthyRuntime();
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

  async request<T>(options: RuntimeRequestOptions): Promise<T> {
    const requestPath = validateRuntimeRequestPath(options.path);
    const headers: Record<string, string> = {};
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (this.runtimeToken) {
      headers["X-Workflow-Platform-Token"] = this.runtimeToken;
    }
    const response = await fetch(`${this.url()}${requestPath}`, {
      method: options.body === undefined ? "GET" : "POST",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) {
      throw new Error(`Runtime API ${requestPath} failed with ${response.status}`);
    }
    return (await response.json()) as T;
  }

  private runtimeArgs(): string[] {
    if (this.runtimeExecutablePath) {
      return [];
    }
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

  private runtimeCommand(): string {
    return this.runtimeExecutablePath ?? this.pythonCommand;
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

  private runtimeEnvironment(): NodeJS.ProcessEnv {
    if (!this.runtimeToken) {
      return this.env;
    }
    return {
      ...this.env,
      WORKFLOW_PLATFORM_RUNTIME_TOKEN: this.runtimeToken,
    };
  }

  private async waitForHealthyRuntime(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.healthRetryAttempts; attempt += 1) {
      try {
        await this.healthCheck(this.url());
        return;
      } catch (error) {
        lastError = error;
        if (attempt < this.healthRetryAttempts) {
          await delay(this.healthRetryDelayMs);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateRuntimeRequestPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
    throw new Error("Runtime request path must be a relative API path");
  }
  return path;
}

async function fetchRuntimeHealth(url: string): Promise<RuntimeHealth> {
  const response = await fetch(`${url}/health`);
  if (!response.ok) {
    throw new Error(`Runtime health failed with ${response.status}`);
  }
  return (await response.json()) as RuntimeHealth;
}

function runtimePortFromEnvironment(env: NodeJS.ProcessEnv): number {
  const value = Number(env.WORKFLOW_PLATFORM_RUNTIME_PORT);
  return Number.isInteger(value) && value >= 1 && value <= 65_535 ? value : 8765;
}
