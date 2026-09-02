import { createFileRoute } from "@tanstack/react-router";
import { waitUntil } from "@vercel/functions";
import { getLatch } from "@/lib/latch";
import { getSessionUserFromHeaders } from "@/lib/session";
import { verifyChannelLink } from "@/lib/channel-link";
import { LINK_KINDS, isChannelKind } from "@/lib/channel-link-kinds";
import { renderLinkConfirmPage } from "@/lib/channel-link-confirm";
import { channelLinkCsrfToken, readCsrfField, verifyChannelLinkCsrf } from "@/lib/channel-link-csrf";
import type { ChannelKind } from "@/lib/channel-store";

/**
 * Account-link landing for every chat channel (`/link/telegram`, `/link/slack`,
 * `/link/whatsapp`). A bot sends a signed link to a specific platform user; the
 * link identifies the PLATFORM side, while the Latch side comes from the browser
 * session — two identities that may belong to different people (a forwarded
 * link, a shared machine). So GET only renders a confirmation page showing
 * both; the link is written on the explicit POST, CSRF-bound to the pair. A
 * link already claimed by a DIFFERENT Latch user is refused, and the message
 * that triggered the link prompt is replayed afterwards.
 *
 * Everything channel-specific is in `LINK_KINDS`.
 */

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

/** Shared guards for GET and POST: kind, token, session, binding, org membership. */
async function prepare(request: Request, kindParam: string) {
  if (!isChannelKind(kindParam)) return { ok: false, response: new Response("unknown channel", { status: 404 }) } as const;
  const kind: ChannelKind = kindParam;
  const adapter = LINK_KINDS[kind];
  const fail = (code: string) => ({ ok: false, response: redirect(`/agents?${kind}=${code}`) }) as const;

  const url = new URL(request.url);
  const botRef = url.searchParams.get("ref") ?? "";
  const externalId = url.searchParams.get("user") ?? "";
  const meta = url.searchParams.get("meta") ?? "";
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";
  const ref = { kind, botRef, externalId, ...(meta ? { meta } : {}) };
  if (!botRef || !externalId || !verifyChannelLink(ref, exp, sig)) return fail("link_error");

  const session = await getSessionUserFromHeaders(request.headers);
  if (!session?.principal.userId) {
    // Log in first, then re-open the link from the chat.
    return {
      ok: false,
      response: redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`),
    } as const;
  }

  const binding = await adapter.binding(botRef, meta);
  if (!binding) return fail("link_error");
  // The link grants a principal in the binding's org — never mint one for a
  // user who isn't a member of that org.
  if (binding.orgId !== session.principal.orgId) return fail("link_wrong_org");

  return {
    ok: true,
    kind,
    adapter,
    url,
    botRef,
    externalId,
    meta,
    exp,
    session,
    binding,
    identity: adapter.identityRef(botRef, meta, externalId),
    // CSRF identities: both sides of the link plus the expiry (see channel-link-csrf.ts).
    csrf: {
      channel: kind,
      scopeId: botRef,
      externalId,
      sessionUserId: session.principal.userId,
      exp,
    },
  } as const;
}

async function handleConfirmPage(request: Request, kind: string): Promise<Response> {
  const ctx = await prepare(request, kind);
  if (!ctx.ok) return ctx.response;
  const { channelStore } = await getLatch();

  // Re-opening the link when this exact pair is already linked: nothing to
  // confirm — just land on the app.
  const existing = await channelStore.resolveIdentity(ctx.kind, ctx.identity.botRef, ctx.identity.externalId);
  if (existing?.userId === ctx.session.principal.userId) return redirect(`/agents?${ctx.kind}=linked`);

  return renderLinkConfirmPage({
    channelLabel: ctx.adapter.label,
    externalIdentity: ctx.adapter.describe(ctx.externalId, ctx.meta),
    account: { name: ctx.session.name, email: ctx.session.email },
    actionUrl: ctx.url.pathname + ctx.url.search,
    switchAccountUrl: `/login?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`,
    csrfToken: channelLinkCsrfToken(ctx.csrf),
    // Already claimed by someone else: `linkIdentity` is fenced and will
    // return "conflict", so say so now rather than after a doomed click.
    alreadyLinkedElsewhere: Boolean(existing),
  });
}

async function handleLink(request: Request, kind: string): Promise<Response> {
  const ctx = await prepare(request, kind);
  if (!ctx.ok) return ctx.response;
  const { channelStore } = await getLatch();
  const userId = ctx.session.principal.userId!;

  // The token proves this POST came from a confirmation page rendered for THIS
  // pair of identities, i.e. from a GET that already carried this browser's
  // session cookie — which a cross-site attacker cannot arrange.
  if (!verifyChannelLinkCsrf(await readCsrfField(request), ctx.csrf)) {
    return redirect(`/agents?${ctx.kind}=link_error`);
  }

  const outcome = await channelStore.linkIdentity({
    kind: ctx.kind,
    ...ctx.identity,
    userId,
    // The binding's org, not merely the session's — they are verified equal
    // above, and the binding is the single source of truth.
    orgId: ctx.binding.orgId,
    ...(ctx.kind === "telegram" && ctx.meta ? { label: ctx.meta } : {}),
  });
  if (outcome === "conflict") return redirect(`/agents?${ctx.kind}=link_conflict`);

  // Continue the conversation: replay the message that triggered the link. The
  // channel takes the turn lease — a fresh webhook message racing the replay
  // must not start a concurrent run.
  const pendingRef = ctx.adapter.pendingRef(ctx.botRef, ctx.meta, ctx.externalId);
  const pending = await channelStore.takePending(ctx.kind, pendingRef.botRef, pendingRef.externalId);
  if (pending) {
    waitUntil(
      ctx.adapter
        .replay({
          botRef: ctx.botRef,
          meta: ctx.meta,
          externalId: ctx.externalId,
          binding: ctx.binding.data,
          pending,
          userId,
          orgId: ctx.binding.orgId,
        })
        .catch((e) => console.error(`[${ctx.kind}] post-link replay failed:`, e)),
    );
  }
  return redirect(`/agents?${ctx.kind}=linked`);
}

export const Route = createFileRoute("/link/$kind")({
  server: {
    handlers: {
      GET: ({ request, params }) => handleConfirmPage(request, params.kind),
      POST: ({ request, params }) => handleLink(request, params.kind),
    },
  },
});
