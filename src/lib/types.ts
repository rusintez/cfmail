export interface Workspace {
  name: string;
  domain: string;
  cloudflare: {
    accountId: string;
    apiToken: string;
    zoneId?: string;
  };
  worker: {
    name: string;
    endpoint: string;
    token: string;
  };
  d1?: {
    databaseId: string;
  };
  r2?: {
    bucket: string;
  };
  sending?: {
    subdomain: string;
    enabledAt: string;
  };
  addedAt: string;
}

export interface Config {
  workspaces: Workspace[];
  defaultWorkspace?: string;
}

export interface Attachment {
  filename: string;
  mimeType: string;
  size: number;
  cid?: string;
}

export interface EmailMessage {
  id: string;
  domain: string;
  toAddr: string;
  fromAddr: string;
  subject: string;
  sentAt: string | null;
  receivedAt: string;
  latencyMs: number | null;
  text: string | null;
  html: string | null;
  links: string[];
  attachments: Attachment[];
}

export interface EmailMessageFull extends EmailMessage {
  headers: Record<string, string>;
}

export interface ListMessagesQuery {
  to?: string;
  from?: string;
  subject?: string;
  since?: string;
  limit?: number;
}

export interface WaitOptions {
  to?: string | RegExp;
  from?: string | RegExp;
  subject?: string | RegExp;
  timeout?: number;
  pollIntervalMs?: number;
  since?: string;
}
