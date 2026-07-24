/**
 * Minimal WhatsApp Business Cloud API client (Meta Graph API) — just what a
 * channel needs: send text / interactive-button messages and download inbound
 * media. JSON POSTs to `graph.facebook.com/<version>/<phoneNumberId>/messages`
 * with a bearer access token. No SDK.
 */

export type LazyString = string | (() => string | Promise<string>);

const DEFAULT_GRAPH_BASE_URL = "https://graph.facebook.com";
const DEFAULT_API_VERSION = "v25.0";
const DEFAULT_TIMEOUT_MS = 10_000;

export class WhatsappApiError extends Error {
  readonly status: number;

  constructor(op: string, status: number, detail?: string) {
    super(`whatsapp:${op} failed: ${detail ?? `HTTP ${status}`}`);
    this.name = "WhatsappApiError";
    this.status = status;
  }
}

export interface WhatsappApiOptions {
  baseUrl?: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function resolve(value: LazyString): Promise<string> {
  return typeof value === "function" ? value() : value;
}

/** An interactive reply button (Meta caps: 3 buttons, 20-char titles). */
export interface WhatsappReplyButton {
  id: string;
  title: string;
}

export function whatsappApi(
  creds: { accessToken: LazyString; phoneNumberId: LazyString },
  opts: WhatsappApiOptions = {},
) {
  const base = opts.baseUrl ?? DEFAULT_GRAPH_BASE_URL;
  const version = opts.apiVersion ?? DEFAULT_API_VERSION;
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function graphFetch(op: string, path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${base}/${version}/${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${await resolve(creds.accessToken)}`,
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res
          .json()
          .then((j) => (j as { error?: { message?: string } })?.error?.message)
          .catch(() => undefined);
        throw new WhatsappApiError(op, res.status, detail);
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  async function sendPayload(op: string, payload: Record<string, unknown>): Promise<void> {
    await graphFetch(op, `${await resolve(creds.phoneNumberId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    });
  }

  return {
    /** Send a plain text message (link previews off). */
    async sendText(to: string, body: string): Promise<void> {
      await sendPayload("sendText", {
        to,
        type: "text",
        text: { body, preview_url: false },
      });
    },

    /** Send a body with up to 3 quick-reply buttons (approval prompts). */
    async sendReplyButtons(
      to: string,
      body: string,
      buttons: WhatsappReplyButton[],
    ): Promise<void> {
      await sendPayload("sendReplyButtons", {
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: body.slice(0, 1024) },
          action: {
            buttons: buttons.slice(0, 3).map((b) => ({
              type: "reply",
              reply: { id: b.id, title: b.title.slice(0, 20) },
            })),
          },
        },
      });
    },

    /** Resolve an inbound media id to its (short-lived) download URL + metadata. */
    async getMediaInfo(
      mediaId: string,
    ): Promise<{ url?: string; mimeType?: string; fileSize?: number }> {
      const res = await graphFetch("getMediaInfo", mediaId, { method: "GET" });
      const j = (await res.json()) as { url?: string; mime_type?: string; file_size?: number };
      return {
        ...(j.url ? { url: j.url } : {}),
        ...(j.mime_type ? { mimeType: j.mime_type } : {}),
        ...(typeof j.file_size === "number" ? { fileSize: j.file_size } : {}),
      };
    },

    /** Download media from the URL `getMediaInfo` returned (token-authenticated). */
    async downloadMedia(url: string): Promise<Uint8Array> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        const res = await fetchImpl(url, {
          headers: { authorization: `Bearer ${await resolve(creds.accessToken)}` },
          signal: controller.signal,
        });
        if (!res.ok) throw new WhatsappApiError("downloadMedia", res.status);
        return new Uint8Array(await res.arrayBuffer());
      } finally {
        clearTimeout(timer);
      }
    },

    /** Validate credentials: fetch the phone number object (admin "save" check). */
    async checkCredentials(): Promise<{ displayPhoneNumber?: string; verifiedName?: string }> {
      const res = await graphFetch("checkCredentials", await resolve(creds.phoneNumberId), {
        method: "GET",
      });
      const j = (await res.json()) as { display_phone_number?: string; verified_name?: string };
      return {
        ...(j.display_phone_number ? { displayPhoneNumber: j.display_phone_number } : {}),
        ...(j.verified_name ? { verifiedName: j.verified_name } : {}),
      };
    },
  };
}

export type WhatsappClient = ReturnType<typeof whatsappApi>;
