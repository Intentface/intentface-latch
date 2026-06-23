/**
 * Transactional email via Resend's REST API (no SDK dependency). Used by
 * better-auth for password-reset / verification mails. When `RESEND_API_KEY`
 * is unset it logs instead of sending, so dev works without email configured.
 * Set `EMAIL_FROM` to a verified sender (defaults to Resend's test address).
 */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  html?: string;
  text?: string;
}): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM ?? "Latch <onboarding@resend.dev>";

  if (!key) {
    console.warn(`[email] RESEND_API_KEY unset — would send "${opts.subject}" to ${opts.to}`);
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: opts.to, subject: opts.subject, html: opts.html, text: opts.text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[email] Resend failed (${res.status}): ${body}`);
  }
}
