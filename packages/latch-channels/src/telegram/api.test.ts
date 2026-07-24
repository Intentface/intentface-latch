import { describe, expect, it, vi } from "vitest";
import { TelegramApiError, telegramApi } from "./api.js";

function fetchReturning(json: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(json), { status }));
}

describe("telegramApi", () => {
  it("POSTs setWebhook with the secret token and allowed_updates", async () => {
    const fetchImpl = fetchReturning({ ok: true, result: true });
    const api = telegramApi("TOKEN", { fetchImpl: fetchImpl as unknown as typeof fetch });
    await api.setWebhook({ url: "https://x.example/api/telegram/b1/events", secretToken: "shh" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/botTOKEN/setWebhook");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      url: "https://x.example/api/telegram/b1/events",
      secret_token: "shh",
      allowed_updates: ["message", "callback_query"],
    });
  });

  it("resolves a lazy token per call (vault-backed rotation)", async () => {
    const fetchImpl = fetchReturning({ ok: true, result: { id: 1, username: "b", first_name: "" } });
    const token = vi.fn(async () => "LAZY");
    const api = telegramApi(token, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await api.getMe();
    expect(token).toHaveBeenCalled();
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain("/botLAZY/");
  });

  it("unwraps getMe and validates the shape", async () => {
    const fetchImpl = fetchReturning({
      ok: true,
      result: { id: 42, username: "acme_bot", first_name: "Acme" },
    });
    const api = telegramApi("T", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await api.getMe()).toEqual({ id: 42, username: "acme_bot", firstName: "Acme" });
  });

  it("throws TelegramApiError with retryAfter on 429", async () => {
    const fetchImpl = fetchReturning(
      { ok: false, description: "Too Many Requests", parameters: { retry_after: 7 } },
      429,
    );
    const api = telegramApi("T", { fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = await api.sendMessage({ chat_id: 1, text: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as TelegramApiError).status).toBe(429);
    expect((err as TelegramApiError).retryAfter).toBe(7);
  });

  it("maps webhook info to camelCase", async () => {
    const fetchImpl = fetchReturning({
      ok: true,
      result: { url: "https://x", pending_update_count: 3, last_error_message: "boom" },
    });
    const api = telegramApi("T", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await api.getWebhookInfo()).toEqual({
      url: "https://x",
      pendingUpdateCount: 3,
      lastErrorMessage: "boom",
    });
  });
});
