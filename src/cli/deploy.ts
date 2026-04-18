import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCatchAllRule,
  createD1Database,
  createR2Bucket,
  enableEmailRouting,
  enableWorkerSubdomain,
  findD1Database,
  findZoneByDomain,
  queryD1,
  setEmailRoutingMx,
  uploadWorker,
} from "../lib/cf-api.js";
import { upsertWorkspace } from "../lib/config.js";
import type { Workspace } from "../lib/types.js";

function assetDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function loadWorkerBundle(): string {
  return readFileSync(join(assetDir(), "worker.js"), "utf-8");
}

function loadStatements(file: string): string[] {
  const sql = readFileSync(join(assetDir(), file), "utf-8");
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function workerNameFor(workspace: string): string {
  return `cfmail-${workspace.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

export async function provisionWorkspace(input: {
  apiToken: string;
  domain: string;
}): Promise<Workspace> {
  const name = input.domain;
  const workerName = workerNameFor(name);

  process.stdout.write(`→ finding zone for ${input.domain}...`);
  const zone = await findZoneByDomain(
    { apiToken: input.apiToken, accountId: "" },
    input.domain,
  );
  if (!zone) throw new Error(`no Cloudflare zone owns ${input.domain}`);
  console.log(` ${zone.name} (${zone.id})  account=${zone.accountId}`);
  const creds = { apiToken: input.apiToken, accountId: zone.accountId };

  process.stdout.write(`→ creating D1 database...`);
  const existing = await findD1Database(creds, workerName);
  const db = existing ?? (await createD1Database(creds, workerName));
  console.log(` ${db.uuid}${existing ? " (reused)" : ""}`);

  process.stdout.write(`→ applying schema...`);
  for (const stmt of loadStatements("schema.sql")) {
    await queryD1(creds, db.uuid, stmt);
  }
  for (const stmt of loadStatements("migrations.sql")) {
    try {
      await queryD1(creds, db.uuid, stmt);
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (!/duplicate column/i.test(msg) && !/already exists/i.test(msg)) throw e;
    }
  }
  console.log(" done");

  const bucketName = workerName;
  process.stdout.write(`→ creating R2 bucket...`);
  await createR2Bucket(creds, bucketName);
  console.log(` ${bucketName}`);

  const cfmailToken = randomToken();

  process.stdout.write(`→ uploading worker...`);
  await uploadWorker(creds, workerName, loadWorkerBundle(), [
    { type: "d1", name: "DB", id: db.uuid },
    { type: "r2_bucket", name: "BUCKET", bucket_name: bucketName },
    { type: "send_email", name: "EMAIL" },
    { type: "secret_text", name: "CFMAIL_TOKEN", text: cfmailToken },
    { type: "plain_text", name: "CFMAIL_DOMAIN", text: input.domain },
  ]);
  console.log(" done");

  process.stdout.write(`→ enabling workers.dev subdomain...`);
  const { subdomain } = await enableWorkerSubdomain(creds, workerName);
  const endpoint = `https://${workerName}.${subdomain}.workers.dev`;
  console.log(` ${endpoint}`);

  process.stdout.write(`→ enabling email routing on zone...`);
  let routingSkipped = false;
  try {
    await enableEmailRouting(creds, zone.id);
    await setEmailRoutingMx(creds, zone.id);
    console.log(" done");
  } catch (e) {
    routingSkipped = true;
    console.log(` skipped (${(e as Error).message.split(":").pop()?.trim()})`);
    console.log(
      `  ! grant Zone:Email Routing Settings:Edit, or enable manually at https://dash.cloudflare.com/${zone.accountId}/${zone.name}/email/routing`,
    );
  }

  process.stdout.write(`→ creating catch-all rule → worker...`);
  await createCatchAllRule(creds, zone.id, workerName);
  console.log(" done");

  const workspace: Workspace = {
    name,
    domain: input.domain,
    cloudflare: {
      accountId: zone.accountId,
      apiToken: input.apiToken,
      zoneId: zone.id,
    },
    worker: {
      name: workerName,
      endpoint,
      token: cfmailToken,
    },
    d1: { databaseId: db.uuid },
    r2: { bucket: bucketName },
    addedAt: new Date().toISOString(),
  };
  upsertWorkspace(workspace);
  if (routingSkipped) {
    console.log(
      `  ! email routing wasn't enabled automatically — flip it on in the dashboard, then re-run: cfmail config add ${input.domain}`,
    );
  }
  return workspace;
}
