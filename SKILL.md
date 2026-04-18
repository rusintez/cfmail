# cfmail

Cloudflare-native email CLI + SDK. **Receive** mail via Email Routing → D1 + R2, **send** mail via the Worker's `send_email` binding (DKIM by CF). One domain, one token, no third-party SMTP.

Built for: magic-link tests in e2e suites, disposable addresses for signup flows, agents with their own mailbox, transactional outbound mail with attachments.

## Setup

Pre-reqs: a domain on Cloudflare with **no existing MX records** (for inbound). For outbound, a subdomain on the same zone (e.g. `mail.example.com`).

```bash
cfmail config add <domain>
```

Opens the Cloudflare dashboard with a pre-filled API-token template, prompts you to paste the token, then provisions a D1 database + R2 bucket + Worker (with `send_email` binding) and wires up Email Routing with a catch-all → Worker rule.

If Email Routing settings need to be flipped on manually, `cfmail` prints the dashboard URL — enable, re-run `cfmail config add <domain>` (idempotent).

To enable **outbound** on a subdomain:

```bash
cfmail sending enable --subdomain mail.example.com    # auto-applies DNS (SPF/DKIM/MX) to the zone
```

## Workspace Configuration

One workspace per domain. The workspace name **is** the domain.

```bash
cfmail config add example.dev
cfmail config add other.dev
cfmail config list
cfmail config set-default example.dev
cfmail config remove other.dev
cfmail config show              # inspect (secrets redacted)
```

Switch per-command: `-w <domain>` (env: `CFMAIL_WORKSPACE`).

## Commands

### Inbox

| Command                                    | Description                                      |
| ------------------------------------------ | ------------------------------------------------ |
| `cfmail inbox`                             | List recent messages (incl. latency, attach count) |
| `cfmail inbox --to <addr>`                 | Filter by recipient                              |
| `cfmail inbox --from <pat>`                | Filter by sender (substring or `/regex/`)        |
| `cfmail inbox --subject <pat>`             | Filter by subject                                |
| `cfmail inbox --since <iso>`               | Only messages after timestamp                    |
| `cfmail get <id>`                          | Full message (body + attachments list)           |
| `cfmail get <id> --raw [-o file]`          | Dump raw RFC822 from R2                          |
| `cfmail get <id> --attachment <name> [-o]` | Download one attachment                          |
| `cfmail tail`                              | Stream new messages with route latency           |

`<id>` accepts an 8-char prefix.

### Wait (magic-link flows)

Blocks until a matching email arrives, then prints body (or one link):

```bash
cfmail wait --to signup-xyz@example.dev --timeout 60s
cfmail wait --to signup-xyz@example.dev --extract-link
cfmail wait --subject /verify/i --from stripe --timeout 2m --json
```

Flags: `--to`, `--from`, `--subject` (all accept substring or `/regex/flags`), `--timeout <dur>` (exits 124 on timeout, GNU convention), `--extract-link [regex]`, `--json`, `--poll <ms>`.

### Disposable Addresses

```bash
cfmail address --prefix signup       # signup-k3f9pn@example.dev
cfmail address --prefix test --length 10
```

No server state — catch-all accepts any local part. Pure client-side string generation.

### Sending (outbound)

Outbound mail goes through the Worker's built-in `send_email` binding (`env.EMAIL`) — Cloudflare signs DKIM, no extra API key. The Worker exposes `POST /send` (bearer-authed) so the CLI / SDK can submit via multipart form (Mailgun-compatible shape).

```bash
cfmail sending enable --subdomain mail.example.dev   # enable Email Sending on the subdomain + auto-apply DNS
cfmail sending settings                           # inspect state
cfmail sending dns                                # show DNS (current valid/unknown state)

cfmail send -f noreply@mail.example.dev -t user@example.com -s "hi" --text "hi"
cfmail send -f noreply@mail.example.dev -t a@b.com -s "invoice" --html-file ./invoice.html -a ./invoice.pdf
cfmail send -f "Example <noreply@mail.example.dev>" -t a@b.com -s "hi" --text "hi" --inline ./logo.png \
  -H "X-Campaign: spring-2026" --reply-to support@example.dev
```

The sender address must be verified — CF sends a one-click confirmation email to the `from` address the first time you use it; cfmail's inbox catches it at `mail.example.dev`, so you can `cfmail wait --to noreply@mail.example.dev --extract-link` and click it.

**Wire format** (for anyone curling `/send` directly): `POST /send` with `Authorization: Bearer <workspace.worker.token>` and `multipart/form-data` body. Fields: `from`, `to` (repeat), `cc`, `bcc`, `subject`, `text`, `html`, `reply_to`, `h:<Name>` for custom headers, `attachment` (file, repeat), `inline` (file, repeat — CID = basename).

## SDK

Same package exports a TypeScript SDK:

```ts
import { cfmail } from "cfmail";

// uses ~/.config/cfmail/config.json by default
const client = cfmail({ workspace: "example.dev" });

// or explicit
const client = cfmail({
  endpoint: process.env.CFMAIL_ENDPOINT,
  token: process.env.CFMAIL_TOKEN,
});

// disposable mailbox + wait
const mbox = await client.createMailbox({ prefix: "signup" });
await triggerSignup(mbox.address);

const email = await mbox.wait({ subject: /verify/i, timeout: 60_000 });
console.log(email.links[0]);

// attachments
for (const att of email.attachments) {
  const bytes = await email.download(att.filename);
}

// raw .eml
const eml = await email.raw();
```

Resolution order: explicit `{endpoint, token}` > `CFMAIL_ENDPOINT`/`CFMAIL_TOKEN` env > `{workspace}` from config > `CFMAIL_WORKSPACE` env > default workspace.

### Playwright fixture

```ts
import { test as base, expect } from "@playwright/test";
import { withMailbox } from "cfmail/playwright";

const test = base.extend(withMailbox({ workspace: "example.dev" }));

test("magic-link signup", async ({ page, mailbox }) => {
  await page.fill("[name=email]", mailbox.address);
  await page.click("button[type=submit]");

  const email = await mailbox.wait({ subject: /sign in/i });
  await page.goto(email.links[0]);
  await expect(page).toHaveURL(/dashboard/);
});
```

Fixture creates a fresh mailbox per test and destroys it after.

## Data Model

- **D1** — metadata: `id`, `to_addr`, `from_addr`, `subject`, `sent_at`, `received_at`, `text`, `html`, `headers_json`, `links_json`, `attachments_json`, `raw_key`. Indexed on `to_addr`, `received_at`, `domain`.
- **R2** — raw `.eml` at `messages/{id}.eml`, attachments at `messages/{id}/attachments/{filename}`.
- **Worker** — `email()` parses with postal-mime, writes R2, inserts D1; `fetch()` exposes `/health`, `/messages`, `/messages/:id`, `/messages/:id/raw`, `/messages/:id/attachments/:name`. Bearer-token auth.

## Config Location

`~/.config/cfmail/config.json` (respects `$XDG_CONFIG_HOME`).

## Token Permissions

Created via the dashboard template link. Scopes:

- Account: Workers Scripts:Edit, D1:Edit, Workers R2 Storage:Edit
- Zone: DNS:Edit, Email Routing Addresses:Edit, Email Routing Rules:Edit, Zone:Read, Email Routing Settings:Edit (optional — routing can be enabled manually in the dashboard)
