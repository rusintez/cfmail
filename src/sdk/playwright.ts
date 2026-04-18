import { cfmail, type Cfmail, type Mailbox, type CfmailOptions } from "./index.js";

export interface MailboxFixtures {
  cfmail: Cfmail;
  mailbox: Mailbox;
}

export function withMailbox(opts: CfmailOptions = {}): Record<string, unknown> {
  return {
    cfmail: async ({}, use: (c: Cfmail) => Promise<void>) => {
      await use(cfmail(opts));
    },
    mailbox: async (
      { cfmail: c }: { cfmail: Cfmail },
      use: (m: Mailbox) => Promise<void>,
    ) => {
      const mbox = await c.createMailbox();
      try {
        await use(mbox);
      } finally {
        await mbox.destroy();
      }
    },
  };
}
