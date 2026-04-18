import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { resolveWorkspace } from "../lib/resolve.js";
import { CfmailClient } from "../lib/http.js";
import { output, err } from "./output.js";
import type { EmailMessage, EmailMessageFull, WaitOptions } from "../lib/types.js";

function client(workspaceName?: string): CfmailClient {
  const ws = resolveWorkspace(workspaceName);
  return new CfmailClient(ws.worker.endpoint, ws.worker.token);
}

function parseTimeout(input: string): number {
  const m = input.match(/^(\d+)(ms|s|m|h)?$/);
  if (!m) throw new Error(`invalid timeout: ${input}`);
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms":
      return n;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "s":
    case undefined:
      return n * 1000;
  }
  return n * 1000;
}

function matches(email: EmailMessage, opts: { to?: string; from?: string; subject?: string }): boolean {
  const test = (pattern: string | undefined, value: string): boolean => {
    if (!pattern) return true;
    if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
      const end = pattern.lastIndexOf("/");
      const re = new RegExp(pattern.slice(1, end), pattern.slice(end + 1));
      return re.test(value);
    }
    return value.toLowerCase().includes(pattern.toLowerCase());
  };
  return (
    test(opts.to, email.toAddr) &&
    test(opts.from, email.fromAddr) &&
    test(opts.subject, email.subject)
  );
}

export function registerInboxCommands(program: Command): void {
  program
    .command("inbox")
    .description("list recent messages")
    .option("--to <addr>")
    .option("--from <pat>")
    .option("--subject <pat>")
    .option("--since <iso>")
    .option("--limit <n>", "max messages", "50")
    .action(async (opts) => {
      const { workspace, format } = program.optsWithGlobals();
      const c = client(workspace);
      const messages = await c.list({
        to: opts.to,
        from: opts.from,
        subject: opts.subject,
        since: opts.since,
        limit: Number(opts.limit),
      });
      if (format === "json") {
        output(messages, "json");
        return;
      }
      output(
        messages.map((m) => ({
          id: m.id.slice(0, 8),
          receivedAt: m.receivedAt,
          latencyMs: m.latencyMs ?? "",
          attach: m.attachments.length || "",
          from: m.fromAddr,
          to: m.toAddr,
          subject: m.subject,
        })),
        "table",
      );
    });

  program
    .command("get")
    .argument("<id>", "message id (prefix ok)")
    .description("fetch a single message")
    .option("--raw", "dump raw RFC822 to stdout")
    .option("--attachment <filename>", "download a specific attachment")
    .option("-o, --output <path>", "write --raw or --attachment output to a file instead of stdout")
    .action(async (id: string, opts) => {
      const { workspace, format } = program.optsWithGlobals();
      const c = client(workspace);
      const msg = await resolveId(c, id);
      if (!msg) err(`no message matching "${id}"`);

      if (opts.raw) {
        const bytes = await c.raw(msg.id);
        if (opts.output) {
          writeFileSync(opts.output, bytes);
          console.log(`wrote ${bytes.byteLength} bytes → ${opts.output}`);
        } else {
          process.stdout.write(bytes);
        }
        return;
      }

      if (opts.attachment) {
        const bytes = await c.attachment(msg.id, opts.attachment);
        const path = opts.output ?? opts.attachment;
        writeFileSync(path, bytes);
        console.log(`wrote ${bytes.byteLength} bytes → ${path}`);
        return;
      }

      const full = await c.get(msg.id);
      if (format === "json") output(full, "json");
      else printEmail(full);
    });

  program
    .command("wait")
    .description("block until a matching email arrives (perfect for magic-link flows)")
    .option("--to <addr>")
    .option("--from <pat>")
    .option("--subject <pat>")
    .option("--timeout <duration>", "e.g. 60s, 2m", "60s")
    .option("--poll <ms>", "poll interval in ms", "1000")
    .option("--extract-link [regex]", "print the first matching link instead of the body")
    .action(async (opts) => {
      const { workspace, format } = program.optsWithGlobals();
      const c = client(workspace);
      const timeoutMs = parseTimeout(opts.timeout);
      const pollMs = Number(opts.poll);
      const since = new Date().toISOString();
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        const recent = await c.list({
          to: opts.to,
          since,
          limit: 50,
        });
        const match = recent.find((m) =>
          matches(m, { to: opts.to, from: opts.from, subject: opts.subject }),
        );
        if (match) {
          const full = await c.get(match.id);
          if (opts.extractLink !== undefined) {
            const re =
              typeof opts.extractLink === "string"
                ? new RegExp(opts.extractLink)
                : /^https?:\/\//;
            const link = full.links.find((l) => re.test(l));
            if (!link) err("no matching link in email body");
            console.log(link);
            return;
          }
          if (format === "json") output(full, "json");
          else printEmail(full);
          return;
        }
        await sleep(pollMs);
      }
      console.error(`timeout after ${opts.timeout} waiting for email`);
      process.exit(124);
    });

  program
    .command("tail")
    .description("stream new messages as they arrive")
    .option("--to <addr>")
    .option("--from <pat>")
    .option("--subject <pat>")
    .option("--poll <ms>", "poll interval in ms", "1000")
    .action(async (opts) => {
      const { workspace, format } = program.optsWithGlobals();
      const c = client(workspace);
      let since = new Date().toISOString();
      const pollMs = Number(opts.poll);
      process.stderr.write(`Tailing inbox — ^C to stop\n`);
      while (true) {
        const recent = await c.list({ to: opts.to, since, limit: 50 });
        const matched = recent.filter((m) =>
          matches(m, { to: opts.to, from: opts.from, subject: opts.subject }),
        );
        for (const m of matched.slice().reverse()) {
          if (format === "json") console.log(JSON.stringify(m));
          else {
            const nowMs = Date.now();
            const rxAgeMs = nowMs - new Date(m.receivedAt).getTime();
            const routeLat =
              m.latencyMs !== null ? ` route=${m.latencyMs}ms` : "";
            const att =
              m.attachments.length > 0 ? ` attach=${m.attachments.length}` : "";
            console.log(
              `[${m.receivedAt}] age=${rxAgeMs}ms${routeLat}${att}  ${m.fromAddr} → ${m.toAddr}  ${m.subject}`,
            );
          }
          if (m.receivedAt > since) since = m.receivedAt;
        }
        await sleep(pollMs);
      }
    });
}

async function resolveId(c: CfmailClient, idOrPrefix: string): Promise<EmailMessage | undefined> {
  if (idOrPrefix.length >= 32) return { id: idOrPrefix } as EmailMessage;
  const recent = await c.list({ limit: 200 });
  return recent.find((m) => m.id.startsWith(idOrPrefix));
}

function printEmail(m: EmailMessageFull): void {
  console.log(`From:     ${m.fromAddr}`);
  console.log(`To:       ${m.toAddr}`);
  console.log(`Subject:  ${m.subject}`);
  console.log(`Sent:     ${m.sentAt ?? "(unknown)"}`);
  console.log(`Received: ${m.receivedAt}${m.latencyMs !== null ? ` (+${m.latencyMs}ms)` : ""}`);
  if (m.links.length > 0) console.log(`Links:    ${m.links.join(", ")}`);
  if (m.attachments.length > 0) {
    console.log(`Attachments:`);
    for (const a of m.attachments) {
      console.log(`  - ${a.filename} (${a.mimeType}, ${a.size} bytes)`);
    }
  }
  console.log("");
  console.log(m.text ?? m.html ?? "(no body)");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
