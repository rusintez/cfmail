# cfmail

Receive **and send** email on any dev domain via Cloudflare. CLI + TypeScript SDK + Playwright fixture. No Gmail, no IMAP, no Mailgun — one vendor, one token.

```bash
cfmail config add example.dev
cfmail wait --to signup-xyz@example.dev --extract-link

cfmail sending enable --subdomain mail.example.dev
cfmail send -f noreply@mail.example.dev -t user@example.com -s "hi" --text "hi"
```

## Why

- **Magic-link tests** — block until the signup email arrives, extract the link, follow it.
- **Agents with email** — give an AI agent `agent-42@yourdomain.dev` and let it receive mail autonomously.
- **Disposable addresses** — catch-all accepts `anything@yourdomain.dev`, so you can invent addresses on the fly.
- **Outbound too** — CF Email Sending (beta) bound into the worker; DKIM managed by Cloudflare. Multipart form on `POST /send`, attachments + inline supported.

## Install

```bash
npm i -g @rusintez/cfmail       # or: pnpm add -g @rusintez/cfmail
```

Or from source:
```bash
git clone https://github.com/rusintez/cfmail && cd cfmail
pnpm install && pnpm build && pnpm link --global
```

## Quickstart

```bash
cfmail config add example.dev      # browser opens with pre-filled token template; paste token
# → provisions D1 + R2 + Worker, wires Email Routing catch-all → Worker

cfmail address --prefix signup # prints e.g. signup-k3f9pn@example.dev

cfmail inbox                   # list received mail with routing latency
cfmail get <id>                # pretty-print body + attachments
cfmail tail                    # stream as it arrives
```

Full command reference: see [SKILL.md](./SKILL.md).

## SDK

```ts
import { cfmail } from "cfmail";

const client = cfmail({ workspace: "example.dev" });
const mbox = await client.createMailbox({ prefix: "signup" });

await fetch("https://api.example.com/signup", {
  method: "POST",
  body: JSON.stringify({ email: mbox.address }),
});

const email = await mbox.wait({ subject: /verify/i, timeout: 60_000 });
console.log(email.links[0]);
```

## Playwright

```ts
import { test as base, expect } from "@playwright/test";
import { withMailbox } from "cfmail/playwright";

const test = base.extend(withMailbox({ workspace: "example.dev" }));

test("signup", async ({ page, mailbox }) => {
  await page.fill("[name=email]", mailbox.address);
  await page.click("button[type=submit]");
  const email = await mailbox.wait({ subject: /sign in/i });
  await page.goto(email.links[0]);
  await expect(page).toHaveURL(/dashboard/);
});
```

## Architecture

```
inbound:  sender → CF Email Routing MX → Email Worker
                                          ├── postal-mime parse
                                          ├── R2 ← raw.eml + attachments
                                          └── D1 ← metadata row
                                                  ↑
                                              GET /messages (bearer) ← CLI / SDK

outbound: CLI / SDK ─── POST /send (bearer, multipart) ───▶ Email Worker
                                                           │
                                                           └── env.EMAIL.send(...)
                                                                 │ DKIM by CF
                                                                 ▼
                                                            Recipient inbox
```

- **D1** for metadata (queryable, indexed on recipient + date)
- **R2** for raw RFC822 + attachment bytes (no 1 MiB D1 row cap)
- **Worker** bundle shipped inside the npm package — `cfmail config add` uploads it via the CF REST API (no Wrangler dep at runtime)

## Requirements

- A domain on Cloudflare with no existing MX records
- A Cloudflare API token (CLI opens dashboard with pre-filled template on first run)
- Node ≥ 20

## Config

`~/.config/cfmail/config.json` — one entry per domain.

## License

MIT
