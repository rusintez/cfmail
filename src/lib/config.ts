import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, Workspace } from "./types.js";

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "cfmail");
}

function configFile(): string {
  return join(configDir(), "config.json");
}

function ensureDir(): void {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadConfig(): Config {
  ensureDir();
  const file = configFile();
  if (!existsSync(file)) return { workspaces: [] };
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as Config;
  } catch {
    return { workspaces: [] };
  }
}

export function saveConfig(config: Config): void {
  ensureDir();
  writeFileSync(configFile(), JSON.stringify(config, null, 2));
}

export function getWorkspace(name?: string): Workspace | undefined {
  const config = loadConfig();
  const target = name ?? config.defaultWorkspace;
  if (target) return config.workspaces.find((w) => w.name === target);
  return config.workspaces[0];
}

export function listWorkspaces(): Workspace[] {
  return loadConfig().workspaces;
}

export function upsertWorkspace(workspace: Workspace): void {
  const config = loadConfig();
  const idx = config.workspaces.findIndex((w) => w.name === workspace.name);
  if (idx >= 0) config.workspaces[idx] = workspace;
  else config.workspaces.push(workspace);
  if (!config.defaultWorkspace) config.defaultWorkspace = workspace.name;
  saveConfig(config);
}

export function removeWorkspace(name: string): boolean {
  const config = loadConfig();
  const idx = config.workspaces.findIndex((w) => w.name === name);
  if (idx < 0) return false;
  config.workspaces.splice(idx, 1);
  if (config.defaultWorkspace === name) {
    config.defaultWorkspace = config.workspaces[0]?.name;
  }
  saveConfig(config);
  return true;
}

export function setDefaultWorkspace(name: string): boolean {
  const config = loadConfig();
  if (!config.workspaces.find((w) => w.name === name)) return false;
  config.defaultWorkspace = name;
  saveConfig(config);
  return true;
}

export function getDefaultWorkspaceName(): string | undefined {
  return loadConfig().defaultWorkspace;
}
