import { Command } from "commander";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  createDnsRecord,
  disableSending,
  enableSending,
  getSendingDns,
  getSendingSettings,
  sendEmail,
  type SendingDnsRecord,
} from "../lib/cf-api.js";
import { upsertWorkspace } from "../lib/config.js";
import { resolveWorkspace } from "../lib/resolve.js";
import { output, err } from "./output.js";
import type { Workspace } from "../lib/types.js";

function creds(ws: Workspace) {
  return { apiToken: ws.cloudflare.apiToken, accountId: ws.cloudflare.accountId };
}

function printDns(records: SendingDnsRecord[]): void {
  if (records.length === 0) {
    console.log("  (no records)");
    return;
  }
  for (const r of records) {
    const prio = r.priority !== undefined ? ` prio=${r.priority}` : "";
    console.log(`  ${r.type.padEnd(5)} ${r.name}${prio}`);
    console.log(`        ${r.content}`);
  }
}

async function applyDnsToZone(
  ws: Workspace,
  records: SendingDnsRecord[],
): Promise<void> {
  if (!ws.cloudflare.zoneId) err("workspace has no zoneId — re-run cfmail config add");
  const c = creds(ws);
  for (const r of records) {
    try {
      await createDnsRecord(c, ws.cloudflare.zoneId!, {
        type: r.type,
        name: r.name,
        content: r.content,
        priority: r.priority,
      });
      console.log(`  ✓ ${r.type.padEnd(5)} ${r.name}`);
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (/already exists/i.test(msg) || /81053/.test(msg)) {
        console.log(`  = ${r.type.padEnd(5)} ${r.name}  (exists)`);
      } else {
        console.log(`  ✘ ${r.type.padEnd(5)} ${r.name}  — ${msg.slice(0, 80)}`);
      }
    }
  }
}

export function registerSendingCommands(program: Command): void {
  const sending = program
    .command("sending")
    .description("manage Cloudflare Email Sending for outbound mail (beta)");

  sending
    .command("enable")
    .description("enable Email Sending on the zone or a subdomain")
    .option("--subdomain <name>", "subdomain host (e.g. mail.example.dev). Omit to enable on the zone apex.")
    .option("--apply-dns", "also write the generated DNS records into the zone", true)
    .option("--no-apply-dns", "skip auto-applying DNS records")
    .action(async (opts) => {
      const { workspace } = program.optsWithGlobals();
      const ws = resolveWorkspace(workspace);
      if (!ws.cloudflare.zoneId) err("no zoneId on workspace; run cfmail config add first");
      const c = creds(ws);

      process.stdout.write(
        `→ enabling Email Sending${opts.subdomain ? ` on ${opts.subdomain}` : ""}...`,
      );
      const res = await enableSending(c, ws.cloudflare.zoneId!, opts.subdomain);
      console.log(` ${res.status}`);

      if (opts.subdomain) {
        upsertWorkspace({
          ...ws,
          sending: { subdomain: opts.subdomain, enabledAt: new Date().toISOString() },
        });
      }

      process.stdout.write(`→ fetching DNS records...`);
      const records = await getSendingDns(c, ws.cloudflare.zoneId!);
      const relevant = opts.subdomain
        ? records.filter((r) => r.name === opts.subdomain || r.name.endsWith(`.${opts.subdomain}`))
        : records;
      console.log(` ${relevant.length} record(s)`);
      console.log();
      printDns(relevant);

      if (opts.applyDns && relevant.length > 0) {
        console.log(`\n→ applying records to zone ${ws.domain}...`);
        await applyDnsToZone(ws, relevant);
      }

      console.log(
        `\n  Next: verify the sender address (CF sends a confirmation to your 'from' address).\n  After adding it you can run:  cfmail sending send --from <addr> --to <addr> -s hi --text hi`,
      );
    });

  sending
    .command("disable")
    .description("disable Email Sending on the zone or a subdomain")
    .option("--subdomain <name>")
    .action(async (opts) => {
      const { workspace } = program.optsWithGlobals();
      const ws = resolveWorkspace(workspace);
      if (!ws.cloudflare.zoneId) err("no zoneId on workspace");
      const res = await disableSending(
        creds(ws),
        ws.cloudflare.zoneId!,
        opts.subdomain,
      );
      console.log(`Sending disabled (status=${res.status})`);
      if (opts.subdomain && ws.sending?.subdomain === opts.subdomain) {
        upsertWorkspace({ ...ws, sending: undefined as unknown as Workspace["sending"] });
      }
    });

  sending
    .command("settings")
    .description("show Email Sending settings for the zone")
    .action(async () => {
      const { workspace, format } = program.optsWithGlobals();
      const ws = resolveWorkspace(workspace);
      if (!ws.cloudflare.zoneId) err("no zoneId on workspace");
      const settings = await getSendingSettings(creds(ws), ws.cloudflare.zoneId!);
      if (format === "json") {
        output(settings, "json");
        return;
      }
      console.log(`zone:      ${settings.name}`);
      console.log(`enabled:   ${settings.enabled}`);
      console.log(`status:    ${settings.status}`);
      if (settings.subdomains && settings.subdomains.length > 0) {
        console.log(`subdomains:`);
        for (const s of settings.subdomains) {
          console.log(`  - ${s.name}  enabled=${s.enabled}  status=${s.status}`);
        }
      }
    });

  const dns = sending
    .command("dns")
    .description("inspect and apply DNS records for Email Sending");

  dns
    .command("show", { isDefault: true })
    .description("print the DNS records CF needs for sending")
    .action(async () => {
      const { workspace, format } = program.optsWithGlobals();
      const ws = resolveWorkspace(workspace);
      if (!ws.cloudflare.zoneId) err("no zoneId on workspace");
      const records = await getSendingDns(creds(ws), ws.cloudflare.zoneId!);
      if (format === "json") {
        output(records, "json");
        return;
      }
      printDns(records);
    });

  dns
    .command("apply")
    .description("write the required DNS records into the zone")
    .action(async () => {
      const { workspace } = program.optsWithGlobals();
      const ws = resolveWorkspace(workspace);
      if (!ws.cloudflare.zoneId) err("no zoneId on workspace");
      const records = await getSendingDns(creds(ws), ws.cloudflare.zoneId!);
      if (records.length === 0) {
        console.log("No DNS records to apply (sending may not be enabled).");
        return;
      }
      await applyDnsToZone(ws, records);
    });

  sending
    .command("send")
    .description("send an email via Cloudflare Email Sending")
    .requiredOption("-f, --from <addr>", "sender address (must be a verified sender on an enabled subdomain)")
    .requiredOption("-t, --to <addr...>", "recipient (may repeat)")
    .option("--cc <addr...>")
    .option("--bcc <addr...>")
    .requiredOption("-s, --subject <subject>")
    .option("--text <text>", "plain-text body")
    .option("--text-file <path>")
    .option("--html <html>")
    .option("--html-file <path>")
    .option("--reply-to <addr>")
    .option("-a, --attach <path...>", "attach a file (may repeat)")
    .option("-H, --header <pair...>", 'custom header "Name: value"')
    .action(async (opts) => {
      const { workspace, format } = program.optsWithGlobals();
      const ws = resolveWorkspace(workspace);

      const text =
        opts.text ??
        (opts.textFile ? readFileSync(opts.textFile, "utf-8") : undefined);
      const html =
        opts.html ??
        (opts.htmlFile ? readFileSync(opts.htmlFile, "utf-8") : undefined);
      if (!text && !html) err("provide --text / --text-file or --html / --html-file");

      const headers: Record<string, string> = {};
      for (const pair of (opts.header ?? []) as string[]) {
        const idx = pair.indexOf(":");
        if (idx < 0) err(`invalid header: ${pair}`);
        headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
      }

      const attachments = (opts.attach ?? []).map((p: string) => ({
        filename: basename(p),
        content: readFileSync(p).toString("base64"),
      }));

      const res = await sendEmail(creds(ws), {
        from: opts.from,
        to: opts.to,
        cc: opts.cc,
        bcc: opts.bcc,
        subject: opts.subject,
        text,
        html,
        reply_to: opts.replyTo,
        headers: Object.keys(headers).length ? headers : undefined,
        attachments: attachments.length ? attachments : undefined,
      });

      if (format === "json") {
        output(res, "json");
        return;
      }
      const delivered = res.delivered ?? [];
      const queued = res.queued ?? [];
      const bounces = res.permanent_bounces ?? [];
      console.log(
        `✓ delivered=${delivered.length}  queued=${queued.length}  bounced=${bounces.length}`,
      );
      for (const b of bounces) console.log(`  ✘ ${b.recipient}: ${b.reason}`);
    });
}
