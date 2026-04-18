import { Command, Option } from "commander";
import { registerConfigCommands } from "./config.js";
import { registerAddressCommands } from "./address.js";
import { registerInboxCommands } from "./inbox.js";
import { registerSendingCommands } from "./sending.js";
import { registerSendCommands } from "./send.js";

const program = new Command();

program
  .name("cfmail")
  .description(
    "Cloudflare Email Routing CLI — receive mail on any dev domain, no Gmail required",
  )
  .version("0.0.1")
  .addOption(
    new Option("-w, --workspace <name>", "Workspace to use").env(
      "CFMAIL_WORKSPACE",
    ),
  )
  .addOption(
    new Option("--format <format>", "Output format")
      .choices(["json", "table"])
      .default("table"),
  );

registerConfigCommands(program);
registerAddressCommands(program);
registerInboxCommands(program);
registerSendingCommands(program);
registerSendCommands(program);

program.parseAsync().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
