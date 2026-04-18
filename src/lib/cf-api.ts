const CF_BASE = "https://api.cloudflare.com/client/v4";

export interface CfCreds {
  accountId: string;
  apiToken: string;
}

interface CfResult<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: unknown[];
  result: T;
}

async function cf<T>(
  creds: CfCreds,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${CF_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${creds.apiToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  let json: CfResult<T> | null = null;
  try {
    json = JSON.parse(text) as CfResult<T>;
  } catch {
    throw new Error(
      `Cloudflare API ${path} → ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  if (!json.success) {
    const msg = json.errors?.map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(`Cloudflare API ${path} failed: ${msg || res.status}`);
  }
  return json.result;
}

export async function listZones(
  creds: CfCreds,
  name?: string,
): Promise<Array<{ id: string; name: string; account: { id: string } }>> {
  const q = name ? `?name=${encodeURIComponent(name)}` : "";
  return cf(creds, `/zones${q}`);
}

export async function findZoneByDomain(
  creds: CfCreds,
  domain: string,
): Promise<{ id: string; name: string; accountId: string } | undefined> {
  const parts = domain.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join(".");
    const zones = await listZones(creds, candidate);
    if (zones.length > 0) {
      return {
        id: zones[0]!.id,
        name: zones[0]!.name,
        accountId: zones[0]!.account.id,
      };
    }
  }
  return undefined;
}

export async function createD1Database(
  creds: CfCreds,
  name: string,
): Promise<{ uuid: string; name: string }> {
  return cf(creds, `/accounts/${creds.accountId}/d1/database`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function findD1Database(
  creds: CfCreds,
  name: string,
): Promise<{ uuid: string; name: string } | undefined> {
  const list = await cf<Array<{ uuid: string; name: string }>>(
    creds,
    `/accounts/${creds.accountId}/d1/database?name=${encodeURIComponent(name)}`,
  );
  return list.find((db) => db.name === name);
}

export async function queryD1(
  creds: CfCreds,
  databaseId: string,
  sql: string,
  params: unknown[] = [],
): Promise<unknown> {
  return cf(creds, `/accounts/${creds.accountId}/d1/database/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({ sql, params }),
  });
}

export interface WorkerBinding {
  type: "d1" | "r2_bucket" | "secret_text" | "plain_text" | "send_email";
  name: string;
  id?: string;
  bucket_name?: string;
  text?: string;
  destination_address?: string;
  allowed_destination_addresses?: string[];
  allowed_sender_addresses?: string[];
}

export async function createR2Bucket(
  creds: CfCreds,
  name: string,
): Promise<void> {
  try {
    await cf(creds, `/accounts/${creds.accountId}/r2/buckets`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (!/already exists/i.test(msg) && !/10004/.test(msg)) throw e;
  }
}

export async function uploadWorker(
  creds: CfCreds,
  workerName: string,
  script: string,
  bindings: WorkerBinding[],
): Promise<void> {
  const metadata = {
    main_module: "worker.js",
    compatibility_date: "2025-01-01",
    compatibility_flags: ["nodejs_compat"],
    bindings,
  };
  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
  );
  form.append(
    "worker.js",
    new Blob([script], { type: "application/javascript+module" }),
    "worker.js",
  );

  const res = await fetch(
    `${CF_BASE}/accounts/${creds.accountId}/workers/scripts/${workerName}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${creds.apiToken}` },
      body: form,
    },
  );
  const json = (await res.json()) as CfResult<unknown>;
  if (!json.success) {
    const msg = json.errors?.map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(`Worker upload failed: ${msg || res.status}`);
  }
}

export async function enableWorkerSubdomain(
  creds: CfCreds,
  workerName: string,
): Promise<{ subdomain: string }> {
  await cf(creds, `/accounts/${creds.accountId}/workers/scripts/${workerName}/subdomain`, {
    method: "POST",
    body: JSON.stringify({ enabled: true }),
  });
  const sub = await cf<{ subdomain: string }>(
    creds,
    `/accounts/${creds.accountId}/workers/subdomain`,
  );
  return sub;
}

export async function enableEmailRouting(
  creds: CfCreds,
  zoneId: string,
): Promise<void> {
  try {
    await cf(creds, `/zones/${zoneId}/email/routing/enable`, {
      method: "POST",
    });
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (!/already|enabled/i.test(msg)) throw e;
  }
}

export async function setEmailRoutingMx(
  creds: CfCreds,
  zoneId: string,
): Promise<void> {
  try {
    await cf(creds, `/zones/${zoneId}/email/routing/dns`, { method: "POST" });
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (!/already|exists/i.test(msg)) throw e;
  }
}

export interface SendingDnsRecord {
  type: string;
  name: string;
  content: string;
  priority?: number;
  ttl?: number;
}

export interface SendingSettings {
  name: string;
  enabled: boolean;
  status: string;
  created?: string;
  modified?: string;
  subdomains?: Array<{
    name: string;
    enabled: boolean;
    status: string;
    tag?: string;
  }>;
}

export async function getSendingSettings(
  creds: CfCreds,
  zoneId: string,
): Promise<SendingSettings> {
  return cf(creds, `/zones/${zoneId}/email/sending`);
}

export async function enableSending(
  creds: CfCreds,
  zoneId: string,
  subdomain?: string,
): Promise<{ name: string; status: string }> {
  return cf(creds, `/zones/${zoneId}/email/sending/enable`, {
    method: "POST",
    body: JSON.stringify(subdomain ? { name: subdomain } : {}),
  });
}

export async function disableSending(
  creds: CfCreds,
  zoneId: string,
  subdomain?: string,
): Promise<{ name: string; status: string }> {
  return cf(creds, `/zones/${zoneId}/email/sending/disable`, {
    method: "POST",
    body: JSON.stringify(subdomain ? { name: subdomain } : {}),
  });
}

export async function getSendingDns(
  creds: CfCreds,
  zoneId: string,
  subdomainId?: string,
): Promise<SendingDnsRecord[]> {
  const path = subdomainId
    ? `/zones/${zoneId}/email/sending/subdomains/${subdomainId}/dns`
    : `/zones/${zoneId}/email/sending/dns`;
  return cf(creds, path);
}

export interface SendMessageInput {
  from: string;
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  cc?: string | string[];
  bcc?: string | string[];
  reply_to?: string;
  headers?: Record<string, string>;
  attachments?: Array<{ filename: string; content: string; content_type?: string }>;
}

export interface SendResult {
  delivered?: string[];
  queued?: string[];
  permanent_bounces?: Array<{ recipient: string; reason: string }>;
}

export async function sendEmail(
  creds: CfCreds,
  input: SendMessageInput,
): Promise<SendResult> {
  return cf(creds, `/accounts/${creds.accountId}/email/sending/send`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function createDnsRecord(
  creds: CfCreds,
  zoneId: string,
  record: {
    type: string;
    name: string;
    content: string;
    priority?: number;
    ttl?: number;
    proxied?: boolean;
  },
): Promise<{ id: string }> {
  return cf(creds, `/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify({ ttl: 1, proxied: false, ...record }),
  });
}

export async function createCatchAllRule(
  creds: CfCreds,
  zoneId: string,
  workerName: string,
): Promise<void> {
  const body = {
    enabled: true,
    name: "cfmail catch-all",
    matchers: [{ type: "all" }],
    actions: [{ type: "worker", value: [workerName] }],
  };
  await cf(creds, `/zones/${zoneId}/email/routing/rules/catch_all`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}
