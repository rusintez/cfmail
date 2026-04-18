import { getWorkspace, loadConfig } from "./config.js";
import type { Workspace } from "./types.js";

export function resolveWorkspace(flag?: string): Workspace {
  const name = flag ?? process.env.CFMAIL_WORKSPACE;
  const ws = getWorkspace(name);
  if (ws) return ws;

  const available = loadConfig()
    .workspaces.map((w) => w.name)
    .join(", ");
  if (name) {
    throw new Error(
      available
        ? `Workspace "${name}" not found. Available: ${available}`
        : `Workspace "${name}" not found. Run: cfmail config add <name>`,
    );
  }
  throw new Error(
    "No workspace configured. Run: cfmail config add <name>",
  );
}
