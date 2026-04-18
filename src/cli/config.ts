import { Command } from "commander";
import { exec } from "node:child_process";
import prompts from "prompts";
import {
  listWorkspaces,
  removeWorkspace,
  setDefaultWorkspace,
  getDefaultWorkspaceName,
  loadConfig,
} from "../lib/config.js";
import { output, err } from "./output.js";
import { provisionWorkspace } from "./deploy.js";

function buildTokenTemplateUrl(): string {
  const permissions = [
    { key: "workers_scripts", type: "edit" },
    { key: "d1", type: "edit" },
    { key: "workers_r2_storage", type: "edit" },
    { key: "dns", type: "edit" },
    { key: "email_routing_addresses", type: "edit" },
    { key: "email_routing_rules", type: "edit" },
    { key: "email_sending", type: "write" },
    { key: "zone", type: "read" },
    { key: "account_settings", type: "read" },
  ];
  const encoded = encodeURIComponent(JSON.stringify(permissions));
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encoded}&name=cfmail&accountId=*&zoneId=all`;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  exec(`${cmd} "${url}"`);
}

export function registerConfigCommands(program: Command): void {
  const config = program
    .command("config")
    .description("manage workspaces and Cloudflare credentials");

  config
    .command("add")
    .description("add a workspace: prompts for CF token, then provisions the worker & routing. Workspace name = domain.")
    .argument("[domain]", "domain to route email for (also used as workspace name)")
    .option("--api-token <token>", "Cloudflare API token")
    .action(async (domainArg: string | undefined, opts) => {
      let apiToken: string = opts.apiToken;
      if (!apiToken) {
        const url = buildTokenTemplateUrl();
        console.log(
          "\nOpening Cloudflare dashboard to create an API token with the required permissions...",
        );
        console.log(`If the browser didn't open, visit:\n  ${url}\n`);
        openBrowser(url);
        apiToken = (
          await prompts(
            {
              type: "password",
              name: "apiToken",
              message: "Paste your Cloudflare API token",
              validate: (v: string) => (v.trim() ? true : "required"),
            },
            { onCancel: () => process.exit(1) },
          )
        ).apiToken;
      }

      const domain =
        domainArg ??
        (
          await prompts(
            {
              type: "text",
              name: "domain",
              message: "Domain to route (must be on Cloudflare, with no MX set)",
              validate: (v: string) =>
                /^[a-z0-9.-]+\.[a-z]+$/i.test(v) ? true : "invalid domain",
            },
            { onCancel: () => process.exit(1) },
          )
        ).domain;

      const ws = await provisionWorkspace({ apiToken, domain });
      console.log(`\n  ✓ Workspace "${ws.name}" ready`);
      console.log(`    domain:   ${ws.domain}`);
      console.log(`    worker:   ${ws.worker.endpoint}`);
      console.log(`    send a test mail to anything@${ws.domain}`);
    });

  config
    .command("list")
    .alias("ls")
    .description("list configured workspaces")
    .action(() => {
      const { format } = program.optsWithGlobals();
      const workspaces = listWorkspaces();
      const def = getDefaultWorkspaceName();
      if (workspaces.length === 0) {
        console.log("No workspaces configured. Run: cfmail config add <name>");
        return;
      }
      output(
        workspaces.map((w) => ({
          name: w.name + (w.name === def ? " (default)" : ""),
          domain: w.domain,
          endpoint: w.worker.endpoint,
        })),
        format,
      );
    });

  config
    .command("remove")
    .alias("rm")
    .argument("<name>", "workspace name")
    .description("remove a workspace from local config (does not delete the CF worker)")
    .action((name: string) => {
      if (!removeWorkspace(name)) err(`workspace "${name}" not found`);
      console.log(`Removed "${name}".`);
    });

  config
    .command("set-default")
    .argument("<name>", "workspace name")
    .description("set the default workspace")
    .action((name: string) => {
      if (!setDefaultWorkspace(name)) err(`workspace "${name}" not found`);
      console.log(`Default workspace set to "${name}".`);
    });

  config
    .command("show")
    .description("print the current config (with secrets redacted)")
    .action(() => {
      const { format } = program.optsWithGlobals();
      const cfg = loadConfig();
      const redacted = {
        ...cfg,
        workspaces: cfg.workspaces.map((w) => ({
          ...w,
          cloudflare: { ...w.cloudflare, apiToken: "***" },
          worker: { ...w.worker, token: "***" },
        })),
      };
      output(redacted, format);
    });
}
