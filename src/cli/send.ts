import { Command } from "commander";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { resolveWorkspace } from "../lib/resolve.js";
import { CfmailClient } from "../lib/http.js";
import { output, err } from "./output.js";

function mimeFor(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "pdf": return "application/pdf";
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    case "txt": return "text/plain";
    case "html": return "text/html";
    case "json": return "application/json";
    case "csv": return "text/csv";
    case "zip": return "application/zip";
  }
  return "application/octet-stream";
}

export function registerSendCommands(program: Command): void {
  program
    .command("send")
    .description("send an email via the workspace's Worker (uses the send_email binding)")
    .requiredOption("-f, --from <addr>", "sender (must be a verified sender on the sending subdomain)")
    .requiredOption("-t, --to <addr...>", "recipient (may repeat)")
    .option("--cc <addr...>")
    .option("--bcc <addr...>")
    .requiredOption("-s, --subject <subject>")
    .option("--text <text>")
    .option("--text-file <path>")
    .option("--html <html>")
    .option("--html-file <path>")
    .option("--reply-to <addr>")
    .option("-a, --attach <path...>", "attachment (may repeat)")
    .option("--inline <path...>", "inline attachment referenceable by CID = basename")
    .option("-H, --header <pair...>", 'custom header "Name: value" (may repeat)')
    .action(async (opts) => {
      const { workspace, format } = program.optsWithGlobals();
      const ws = resolveWorkspace(workspace);
      const client = new CfmailClient(ws.worker.endpoint, ws.worker.token);

      const text =
        opts.text ??
        (opts.textFile ? readFileSync(opts.textFile, "utf-8") : undefined);
      const html =
        opts.html ??
        (opts.htmlFile ? readFileSync(opts.htmlFile, "utf-8") : undefined);
      if (!text && !html) err("provide --text / --text-file or --html / --html-file");

      const form = new FormData();
      form.append("from", opts.from);
      for (const t of opts.to as string[]) form.append("to", t);
      for (const c of (opts.cc as string[] | undefined) ?? []) form.append("cc", c);
      for (const b of (opts.bcc as string[] | undefined) ?? []) form.append("bcc", b);
      form.append("subject", opts.subject);
      if (text !== undefined) form.append("text", text);
      if (html !== undefined) form.append("html", html);
      if (opts.replyTo) form.append("reply_to", opts.replyTo);

      for (const pair of (opts.header as string[] | undefined) ?? []) {
        const idx = pair.indexOf(":");
        if (idx < 0) err(`invalid header: ${pair}`);
        form.append(`h:${pair.slice(0, idx).trim()}`, pair.slice(idx + 1).trim());
      }

      for (const path of (opts.attach as string[] | undefined) ?? []) {
        const bytes = readFileSync(path);
        const filename = basename(path);
        form.append(
          "attachment",
          new Blob([bytes], { type: mimeFor(filename) }),
          filename,
        );
      }
      for (const path of (opts.inline as string[] | undefined) ?? []) {
        const bytes = readFileSync(path);
        const filename = basename(path);
        form.append(
          "inline",
          new Blob([bytes], { type: mimeFor(filename) }),
          filename,
        );
      }

      const result = await client.send(form);
      if (format === "json") {
        output(result, "json");
        return;
      }
      if (result.ok) console.log(`✓ sent  messageId=${result.messageId ?? ""}`);
      else err(`send failed: ${result.error ?? "unknown"}`);
    });
}
