import { Command } from "commander";
import { resolveWorkspace } from "../lib/resolve.js";
import { output } from "./output.js";

function randomLocal(len = 8): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function registerAddressCommands(program: Command): void {
  program
    .command("address")
    .alias("addr")
    .description("generate a disposable email address (client-side; catch-all accepts any local part)")
    .argument("[subcommand]", 'action, defaults to "new"', "new")
    .option("--prefix <prefix>", "prefix for the local part", "test")
    .option("--length <n>", "random suffix length", "6")
    .action((_sub: string, opts) => {
      const { workspace, format } = program.optsWithGlobals();
      const ws = resolveWorkspace(workspace);
      const local = `${opts.prefix}-${randomLocal(Number(opts.length))}`;
      const address = `${local}@${ws.domain}`;
      if (format === "json") {
        output({ address, local, domain: ws.domain }, "json");
      } else {
        console.log(address);
      }
    });
}
