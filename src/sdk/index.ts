import { CfmailClient } from "../lib/http.js";
import type {
  Attachment,
  EmailMessage,
  EmailMessageFull,
  WaitOptions,
} from "../lib/types.js";

export type { Attachment, EmailMessage, EmailMessageFull, WaitOptions };

export interface Email extends EmailMessageFull {
  raw(): Promise<Uint8Array>;
  download(filename: string): Promise<Uint8Array>;
}

export interface CfmailOptions {
  endpoint?: string;
  token?: string;
  workspace?: string;
}

export interface CreateMailboxOptions {
  prefix?: string;
  length?: number;
  address?: string;
}

export interface Cfmail {
  createMailbox(opts?: CreateMailboxOptions): Promise<Mailbox>;
  wait(opts: WaitOptions & { to: string }): Promise<Email>;
  list(query?: { to?: string; from?: string; subject?: string; since?: string; limit?: number }): Promise<EmailMessage[]>;
  get(id: string): Promise<Email>;
}

export interface Mailbox extends AsyncDisposable {
  readonly address: string;
  wait(opts?: WaitOptions): Promise<Email>;
  list(since?: string): Promise<EmailMessage[]>;
  destroy(): Promise<void>;
}

function randomLocal(len = 6): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

async function resolveConfig(opts: CfmailOptions): Promise<{ endpoint: string; token: string; domain: string }> {
  if (opts.endpoint && opts.token) {
    const domain = process.env.CFMAIL_DOMAIN ?? inferDomain(opts.endpoint);
    return { endpoint: opts.endpoint, token: opts.token, domain };
  }
  const envEndpoint = process.env.CFMAIL_ENDPOINT;
  const envToken = process.env.CFMAIL_TOKEN;
  if (envEndpoint && envToken && !opts.workspace) {
    return {
      endpoint: envEndpoint,
      token: envToken,
      domain: process.env.CFMAIL_DOMAIN ?? inferDomain(envEndpoint),
    };
  }
  const { resolveWorkspace } = await import("../lib/resolve.js");
  const ws = resolveWorkspace(opts.workspace);
  return { endpoint: ws.worker.endpoint, token: ws.worker.token, domain: ws.domain };
}

function inferDomain(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "localhost";
  }
}

function matches(m: EmailMessage, w: WaitOptions): boolean {
  const test = (p: string | RegExp | undefined, v: string) => {
    if (!p) return true;
    if (p instanceof RegExp) return p.test(v);
    return v.toLowerCase().includes(p.toLowerCase());
  };
  return test(w.to, m.toAddr) && test(w.from, m.fromAddr) && test(w.subject, m.subject);
}

export function cfmail(opts: CfmailOptions = {}): Cfmail {
  let client: CfmailClient | null = null;
  let domain: string | null = null;

  const ready = async () => {
    if (!client) {
      const cfg = await resolveConfig(opts);
      client = new CfmailClient(cfg.endpoint, cfg.token);
      domain = cfg.domain;
    }
    return { client: client!, domain: domain! };
  };

  const api: Cfmail = {
    async createMailbox(o = {}) {
      const { domain: d } = await ready();
      const address =
        o.address ?? `${o.prefix ?? "test"}-${randomLocal(o.length ?? 6)}@${d}`;
      return makeMailbox(address, ready);
    },

    async wait(o) {
      const { client: c } = await ready();
      return wrap(c, await waitOnce(c, o));
    },

    async list(q = {}) {
      const { client: c } = await ready();
      return c.list(q);
    },

    async get(id) {
      const { client: c } = await ready();
      return wrap(c, await c.get(id));
    },
  };

  return api;
}

function wrap(client: CfmailClient, full: EmailMessageFull): Email {
  return {
    ...full,
    raw: () => client.raw(full.id),
    download: (filename: string) => client.attachment(full.id, filename),
  };
}

function makeMailbox(address: string, ready: () => Promise<{ client: CfmailClient }>): Mailbox {
  const createdAt = new Date().toISOString();

  const mbox: Mailbox = {
    get address() {
      return address;
    },

    async wait(opts: WaitOptions = {}) {
      const { client } = await ready();
      const full = await waitOnce(client, {
        ...opts,
        to: address,
        since: opts.since ?? createdAt,
      });
      return wrap(client, full);
    },

    async list(since?: string) {
      const { client } = await ready();
      return client.list({ to: address, since: since ?? createdAt });
    },

    async destroy() {
      // Nothing server-side to destroy (catch-all accepts any address).
      // Future: if allowlist mode lands, remove the row here.
    },

    async [Symbol.asyncDispose]() {
      await mbox.destroy();
    },
  };

  return mbox;
}

async function waitOnce(
  client: CfmailClient,
  opts: WaitOptions & { to?: string },
): Promise<EmailMessageFull> {
  const timeout = opts.timeout ?? 60_000;
  const poll = opts.pollIntervalMs ?? 1000;
  const since = opts.since ?? new Date().toISOString();
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const recent = await client.list({
      to: typeof opts.to === "string" ? opts.to : undefined,
      since,
      limit: 50,
    });
    const match = recent.find((m) => matches(m, opts));
    if (match) return client.get(match.id);
    await sleep(Math.min(poll, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`cfmail.wait timed out after ${timeout}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function createMailbox(opts: CfmailOptions & CreateMailboxOptions = {}): Promise<Mailbox> {
  const { endpoint, token, workspace, ...rest } = opts;
  const client = cfmail({ endpoint, token, workspace });
  return client.createMailbox(rest);
}
