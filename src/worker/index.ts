import PostalMime from "postal-mime";

interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  EMAIL: SendEmail;
  CFMAIL_TOKEN: string;
  CFMAIL_DOMAIN: string;
}

interface StoredRow {
  id: string;
  domain: string;
  to_addr: string;
  from_addr: string;
  subject: string | null;
  sent_at: string | null;
  received_at: string;
  text: string | null;
  html: string | null;
  headers_json: string;
  links_json: string;
  attachments_json: string;
  raw_key: string | null;
}

interface StoredAttachment {
  filename: string;
  mimeType: string;
  size: number;
  cid?: string;
}

function extractLinks(text: string | null | undefined, html: string | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (u: string) => {
    const trimmed = u.replace(/[)>.,;!\]]+$/, "");
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  };
  if (text) {
    const re = /https?:\/\/[^\s<>"')]+/g;
    for (const m of text.matchAll(re)) push(m[0]);
  }
  if (html) {
    const re = /href\s*=\s*["']([^"']+)["']/gi;
    for (const m of html.matchAll(re)) {
      const u = m[1];
      if (u && /^https?:\/\//i.test(u)) push(u);
    }
  }
  return out;
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return buf;
}

function safeFilename(name: string | null | undefined, fallback: string): string {
  const base = (name ?? fallback).replace(/[/\\\0]/g, "_").trim();
  return base.length > 0 ? base : fallback;
}

function rowToMessage(row: StoredRow, opts: { full: boolean } = { full: false }): Record<string, unknown> {
  const sentAt = row.sent_at;
  const latencyMs = sentAt
    ? new Date(row.received_at).getTime() - new Date(sentAt).getTime()
    : null;
  const base = {
    id: row.id,
    domain: row.domain,
    toAddr: row.to_addr,
    fromAddr: row.from_addr,
    subject: row.subject ?? "",
    sentAt,
    receivedAt: row.received_at,
    latencyMs,
    text: row.text,
    html: row.html,
    links: JSON.parse(row.links_json) as string[],
    attachments: JSON.parse(row.attachments_json ?? "[]") as StoredAttachment[],
  };
  if (opts.full) {
    return {
      ...base,
      headers: JSON.parse(row.headers_json) as Record<string, string>,
    };
  }
  return base;
}

function authed(req: Request, env: Env): boolean {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return m[1] === env.CFMAIL_TOKEN;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function rawKey(id: string): string {
  return `messages/${id}.eml`;
}

function attachmentKey(id: string, filename: string): string {
  return `messages/${id}/attachments/${filename}`;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const rawBytes = await streamToBytes(message.raw);
    const parsed = await PostalMime.parse(rawBytes);
    const id = randomId();
    const toAddr = message.to ?? parsed.to?.[0]?.address ?? "";
    const fromAddr = message.from ?? parsed.from?.address ?? "";
    const subject = parsed.subject ?? "";
    const domain = toAddr.split("@")[1] ?? env.CFMAIL_DOMAIN;
    const receivedAt = new Date().toISOString();
    const sentAt = parsed.date ? new Date(parsed.date).toISOString() : null;
    const text = parsed.text ?? null;
    const html = parsed.html ?? null;
    const links = extractLinks(text, html);
    const headers: Record<string, string> = {};
    for (const h of parsed.headers ?? []) headers[h.key] = h.value;

    const rk = rawKey(id);
    await env.BUCKET.put(rk, rawBytes, {
      httpMetadata: { contentType: "message/rfc822" },
    });

    const attachments: StoredAttachment[] = [];
    for (const [i, att] of (parsed.attachments ?? []).entries()) {
      const filename = safeFilename(att.filename, `attachment-${i}`);
      const content =
        att.content instanceof ArrayBuffer
          ? new Uint8Array(att.content)
          : typeof att.content === "string"
            ? new TextEncoder().encode(att.content)
            : (att.content as Uint8Array);
      await env.BUCKET.put(attachmentKey(id, filename), content, {
        httpMetadata: { contentType: att.mimeType ?? "application/octet-stream" },
      });
      attachments.push({
        filename,
        mimeType: att.mimeType ?? "application/octet-stream",
        size: content.byteLength,
        cid: att.contentId ?? undefined,
      });
    }

    await env.DB.prepare(
      `INSERT INTO messages (id, domain, to_addr, from_addr, subject, sent_at, received_at, text, html, headers_json, links_json, attachments_json, raw_key, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
    )
      .bind(
        id,
        domain,
        toAddr,
        fromAddr,
        subject,
        sentAt,
        receivedAt,
        text,
        html,
        JSON.stringify(headers),
        JSON.stringify(links),
        JSON.stringify(attachments),
        rk,
      )
      .run();
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    if (!authed(req, env)) {
      return new Response("unauthorized", { status: 401 });
    }

    if (url.pathname === "/messages" && req.method === "GET") {
      const to = url.searchParams.get("to");
      const from = url.searchParams.get("from");
      const subject = url.searchParams.get("subject");
      const since = url.searchParams.get("since");
      const limit = Math.min(
        Number(url.searchParams.get("limit") ?? "50"),
        500,
      );

      const clauses: string[] = [];
      const params: unknown[] = [];
      if (to) {
        clauses.push("to_addr = ?");
        params.push(to);
      }
      if (from) {
        clauses.push("from_addr LIKE ?");
        params.push(`%${from}%`);
      }
      if (subject) {
        clauses.push("subject LIKE ?");
        params.push(`%${subject}%`);
      }
      if (since) {
        clauses.push("received_at > ?");
        params.push(since);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const sql = `SELECT * FROM messages ${where} ORDER BY received_at DESC LIMIT ?`;
      params.push(limit);

      const res = await env.DB.prepare(sql).bind(...params).all<StoredRow>();
      return json({
        messages: (res.results ?? []).map((r) => rowToMessage(r)),
      });
    }

    const rawMatch = url.pathname.match(/^\/messages\/([^/]+)\/raw$/);
    if (rawMatch && req.method === "GET") {
      const id = decodeURIComponent(rawMatch[1]!);
      const row = await env.DB.prepare(`SELECT raw_key FROM messages WHERE id = ?`)
        .bind(id)
        .first<{ raw_key: string | null }>();
      if (!row?.raw_key) return new Response("not found", { status: 404 });
      const obj = await env.BUCKET.get(row.raw_key);
      if (!obj) return new Response("raw missing", { status: 404 });
      return new Response(obj.body, {
        headers: { "content-type": "message/rfc822" },
      });
    }

    const attMatch = url.pathname.match(/^\/messages\/([^/]+)\/attachments\/(.+)$/);
    if (attMatch && req.method === "GET") {
      const id = decodeURIComponent(attMatch[1]!);
      const filename = decodeURIComponent(attMatch[2]!);
      const obj = await env.BUCKET.get(attachmentKey(id, filename));
      if (!obj) return new Response("not found", { status: 404 });
      return new Response(obj.body, {
        headers: {
          "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
          "content-disposition": `attachment; filename="${filename}"`,
        },
      });
    }

    if (url.pathname === "/send" && req.method === "POST") {
      const ct = req.headers.get("content-type") ?? "";
      if (!ct.includes("multipart/form-data") && !ct.includes("application/x-www-form-urlencoded")) {
        return new Response("expected multipart/form-data or application/x-www-form-urlencoded", { status: 415 });
      }
      const form = await req.formData();

      const from = String(form.get("from") ?? "");
      const to = form.getAll("to").map(String).filter(Boolean);
      const cc = form.getAll("cc").map(String).filter(Boolean);
      const bcc = form.getAll("bcc").map(String).filter(Boolean);
      const subject = String(form.get("subject") ?? "");
      const text = form.get("text");
      const html = form.get("html");
      const replyTo = form.get("reply_to") ?? form.get("reply-to");

      if (!from || to.length === 0 || !subject) {
        return new Response("missing required field: from, to, subject", { status: 400 });
      }
      if (!text && !html) {
        return new Response("missing body: provide text or html", { status: 400 });
      }

      const headers: Record<string, string> = {};
      for (const [k, v] of form.entries()) {
        if (k.startsWith("h:") && typeof v === "string") {
          headers[k.slice(2)] = v;
        }
      }

      const attachments: EmailAttachment[] = [];
      for (const entry of form.getAll("attachment")) {
        if (typeof entry === "string") continue;
        const f = entry as unknown as File;
        attachments.push({
          disposition: "attachment",
          filename: f.name,
          type: f.type || "application/octet-stream",
          content: await f.arrayBuffer(),
        });
      }
      for (const entry of form.getAll("inline")) {
        if (typeof entry === "string") continue;
        const f = entry as unknown as File;
        attachments.push({
          disposition: "inline",
          contentId: f.name,
          filename: f.name,
          type: f.type || "application/octet-stream",
          content: await f.arrayBuffer(),
        });
      }

      try {
        const result = await env.EMAIL.send({
          from,
          to: to.length === 1 ? to[0]! : to,
          cc: cc.length > 0 ? cc : undefined,
          bcc: bcc.length > 0 ? bcc : undefined,
          subject,
          ...(text !== null ? { text: String(text) } : {}),
          ...(html !== null ? { html: String(html) } : {}),
          ...(replyTo ? { replyTo: String(replyTo) } : {}),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        });
        return json({ ok: true, messageId: result.messageId });
      } catch (e) {
        return json(
          { ok: false, error: (e as Error).message },
          { status: 502 },
        );
      }
    }

    const match = url.pathname.match(/^\/messages\/([^/]+)$/);
    if (match && req.method === "GET") {
      const id = decodeURIComponent(match[1]!);
      const row = await env.DB.prepare(`SELECT * FROM messages WHERE id = ?`)
        .bind(id)
        .first<StoredRow>();
      if (!row) return new Response("not found", { status: 404 });
      return json(rowToMessage(row, { full: true }));
    }

    return new Response("not found", { status: 404 });
  },
};
