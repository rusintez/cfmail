import type {
  EmailMessage,
  EmailMessageFull,
  ListMessagesQuery,
} from "./types.js";

export class CfmailClient {
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
  ) {}

  private async req<T>(path: string): Promise<T> {
    const res = await fetch(`${this.endpoint}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`cfmail ${path} → ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  async list(query: ListMessagesQuery = {}): Promise<EmailMessage[]> {
    const params = new URLSearchParams();
    if (query.to) params.set("to", query.to);
    if (query.from) params.set("from", query.from);
    if (query.subject) params.set("subject", query.subject);
    if (query.since) params.set("since", query.since);
    if (query.limit) params.set("limit", String(query.limit));
    const qs = params.toString();
    const { messages } = await this.req<{ messages: EmailMessage[] }>(
      `/messages${qs ? `?${qs}` : ""}`,
    );
    return messages;
  }

  async get(id: string): Promise<EmailMessageFull> {
    return this.req<EmailMessageFull>(`/messages/${encodeURIComponent(id)}`);
  }

  private async stream(path: string): Promise<Response> {
    const res = await fetch(`${this.endpoint}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`cfmail ${path} → ${res.status}: ${body}`);
    }
    return res;
  }

  async raw(id: string): Promise<Uint8Array> {
    const res = await this.stream(`/messages/${encodeURIComponent(id)}/raw`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async attachment(id: string, filename: string): Promise<Uint8Array> {
    const res = await this.stream(
      `/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(filename)}`,
    );
    return new Uint8Array(await res.arrayBuffer());
  }

  async send(form: FormData): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    const res = await fetch(`${this.endpoint}/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}` },
      body: form,
    });
    const body = await res.json().catch(() => ({})) as {
      ok?: boolean;
      messageId?: string;
      error?: string;
    };
    if (!res.ok) {
      throw new Error(body.error ?? `cfmail /send → ${res.status}`);
    }
    return { ok: body.ok ?? false, messageId: body.messageId, error: body.error };
  }
}
