/**
 * Confirmation page for channel account-linking (`/telegram/link` & friends).
 *
 * Linking is a confused-deputy hazard: the signed URL identifies the CHANNEL
 * user (who received it in a DM), but the account it links to comes from the
 * BROWSER's session. Opened on the wrong machine — a shared test browser, a
 * forwarded link — it would silently bind someone's Telegram to someone
 * else's Latch account, and every later message would run with that account's
 * credentials. So a GET never links: it renders this page showing BOTH
 * identities, and only an explicit POST (the Confirm button) writes the link.
 */

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function renderLinkConfirmPage(opts: {
  /** Channel display name, e.g. "Telegram". */
  channelLabel: string;
  /** The external identity being linked, e.g. `@klaus (id 12345)`. */
  externalIdentity: string;
  /** The logged-in Latch account this identity would be linked to. */
  account: { name?: string; email?: string };
  /** Form target — the link URL itself (path + original signed query). */
  actionUrl: string;
  /** Where "Not you?" sends the user to switch accounts. */
  switchAccountUrl: string;
}): Response {
  const account = [opts.account.name, opts.account.email]
    .filter((v): v is string => Boolean(v))
    .map(esc)
    .join(" · ");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Link ${esc(opts.channelLabel)} account</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; display: grid; place-items: center;
         min-height: 100vh; margin: 0; background: Canvas; color: CanvasText; }
  main { max-width: 26rem; padding: 2rem; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
         border-radius: 12px; }
  h1 { font-size: 1.1rem; margin: 0 0 1rem; }
  dl { margin: 0 0 1.5rem; }
  dt { font-size: .75rem; opacity: .6; text-transform: uppercase; letter-spacing: .05em; }
  dd { margin: .15rem 0 1rem; font-weight: 600; overflow-wrap: anywhere; }
  button { width: 100%; padding: .6rem; border-radius: 8px; border: none; font-weight: 600;
           background: #4f46e5; color: white; cursor: pointer; font-size: 1rem; }
  p.warn { font-size: .85rem; opacity: .75; }
  a { color: inherit; }
</style>
</head>
<body>
<main>
  <h1>Link ${esc(opts.channelLabel)} account?</h1>
  <dl>
    <dt>${esc(opts.channelLabel)} account</dt>
    <dd>${esc(opts.externalIdentity)}</dd>
    <dt>Will be linked to Latch account</dt>
    <dd>${account || "(unnamed account)"}</dd>
  </dl>
  <p class="warn">After linking, messages from this ${esc(opts.channelLabel)} account run agents
  as the Latch account above — with its connections and its data. Only confirm if both are yours.</p>
  <form method="post" action="${esc(opts.actionUrl)}">
    <button type="submit">Confirm link</button>
  </form>
  <p class="warn">Wrong Latch account? <a href="${esc(opts.switchAccountUrl)}">Sign in as someone else</a>
  and reopen the link from ${esc(opts.channelLabel)}.</p>
</main>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
