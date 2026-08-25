import type { Client } from "@libsql/client"
import type { Principal } from "./session"
import type { CredentialScope } from "./credentials"
import type { AgentStore } from "./agent-store"
import type { createTelegramStore } from "./telegram-store"
import type { createWhatsappStore } from "./whatsapp-store"

/**
 * Deleting an agent must not strand what points at it: `latch_schedules` rows
 * keep firing (`runDue` claims them cross-tenant by due-time alone) and
 * Telegram/WhatsApp bot bindings keep routing inbound messages — both paths
 * then throw `Unknown agent: …`, and the Telegram channel echoes that into the
 * user's chat on every occurrence. Nothing in the schema is a foreign key, so
 * the cleanup lives here, at the application level, shared by every delete
 * entry point (the UI server fn and the Agent Builder's delete_agent).
 *
 * Ordering: the recoverable steps run and fail LOUD before the irreversible
 * one. Bindings are disabled first (a `setStatus` flip, trivially reversible);
 * only then is the agent row deleted; schedule rows go last, best-effort —
 * once the agent is gone, refusing the whole op over a schedule row would be a
 * lie, and `runDue`'s orphan guard retires any survivor on its next tick.
 */
export interface AgentDeleteResult {
  ok: boolean
  /** setStatus("disabled") applied — bot handles, for the caller's report. */
  disabledBots: string[]
  deletedSchedules: number
  /** Best-effort failures after the point of no return. */
  warnings: string[]
  /** Set when the delete was aborted before touching the agent row. */
  error?: string
}

/** The `latch_schedules.owner` org half — same derivation as `ownerTagOf`. */
const encodedOrg = (p: Principal): string => encodeURIComponent(p.orgId)

/** Injectable for tests; production callers omit it and get the composition root. */
export interface AgentDeleteDeps {
  agentStore: Pick<AgentStore, "getRecord" | "remove">
  telegramStore: Pick<
    ReturnType<typeof createTelegramStore>,
    "listForOrg" | "setStatus"
  >
  whatsappStore: Pick<
    ReturnType<typeof createWhatsappStore>,
    "listForOrg" | "setStatus"
  >
  client: Client
}

export async function deleteAgentCascade(
  principal: Principal,
  scope: CredentialScope,
  name: string,
  deps?: AgentDeleteDeps
): Promise<AgentDeleteResult> {
  const { agentStore, telegramStore, whatsappStore, client } =
    deps ?? (await (await import("./latch")).getLatch())
  const warnings: string[] = []

  // 1. Record the doomed schedule rows BEFORE the delete, while the ref still
  //    resolves. A stored ref is the bare name or a scope pin (`org:name` /
  //    `user:name` — normalizeAgentName strips `:`, so IN over the three forms
  //    is exhaustive), and the owner key is `org` or `org/user` URL-encoded
  //    (substr, not LIKE: `_` in an org id would be a wildcard). Each candidate
  //    is resolved under ITS OWN identity principal via the pin-aware
  //    `getRecord`; only rows whose resolution lands on the record being
  //    deleted are recorded. Resolving after the delete instead would keep any
  //    bare ref that a same-named agent in the OTHER scope now answers for —
  //    silently re-pointing the schedule at a different agent's instructions.
  const org = encodedOrg(principal)
  const orgPrefix = `${org}/`
  const candidates = await client.execute({
    sql: `SELECT id, agent, identity FROM latch_schedules
          WHERE agent IN (?, ?, ?) AND (owner = ? OR substr(owner, 1, ?) = ?)`,
    args: [
      name,
      `org:${name}`,
      `user:${name}`,
      org,
      orgPrefix.length,
      orgPrefix,
    ],
  })
  const doomed: string[] = []
  for (const row of candidates.rows as unknown as Record<string, unknown>[]) {
    let rowPrincipal: Principal
    try {
      rowPrincipal = JSON.parse(String(row.identity)) as Principal
      if (!rowPrincipal?.orgId) throw new Error("no orgId in identity")
    } catch {
      // Unreadable identity → leave the row for the runDue orphan guard.
      warnings.push(
        `schedule ${String(row.id)}: unreadable identity — left for the orphan guard`
      )
      continue
    }
    const rec = await agentStore.getRecord(rowPrincipal, String(row.agent))
    if (rec && rec.scope === scope && rec.name === name)
      doomed.push(String(row.id))
  }

  // 2. Disable bot bindings — loud: the agent row is still intact, so a
  //    failure here aborts a fully recoverable operation. Bot rows are KEPT
  //    (tokens/config survive; re-enable is a setStatus flip). A binding with
  //    no agentScope points at a code-registry agent and can never mean a UI
  //    record, so it is never touched.
  const disabledBots: string[] = []
  const undo: (() => Promise<void>)[] = []
  try {
    const [tgBots, waBots] = await Promise.all([
      telegramStore.listForOrg(principal.orgId),
      whatsappStore.listForOrg(principal.orgId),
    ])
    for (const b of tgBots) {
      if (b.agent !== name || b.agentScope !== scope || b.status !== "active")
        continue
      await telegramStore.setStatus(b.id, "disabled")
      undo.push(() => telegramStore.setStatus(b.id, "active"))
      disabledBots.push(`telegram:${b.handle}`)
    }
    for (const b of waBots) {
      if (b.agent !== name || b.agentScope !== scope || b.status !== "active")
        continue
      await whatsappStore.setStatus(b.id, "disabled")
      undo.push(() => whatsappStore.setStatus(b.id, "active"))
      disabledBots.push(`whatsapp:${b.handle}`)
    }
  } catch (e) {
    // Roll back what already flipped, then refuse — nothing irreversible ran.
    for (const u of undo) await u().catch(() => {})
    return {
      ok: false,
      disabledBots: [],
      deletedSchedules: 0,
      warnings,
      error: `channel bindings could not be disabled — agent NOT deleted: ${
        e instanceof Error ? e.message : String(e)
      }`,
    }
  }

  // 3. The irreversible step.
  await agentStore.remove(principal, scope, name)

  // 4. Delete the recorded schedule rows — best-effort past the point of no
  //    return. Direct SQL, not runtime.unschedule: an org agent's schedules
  //    belong to every member, and unschedule is fenced to one principal.
  let deletedSchedules = 0
  for (const id of doomed) {
    try {
      await client.execute({
        sql: "DELETE FROM latch_schedules WHERE id = ?",
        args: [id],
      })
      deletedSchedules++
    } catch (e) {
      warnings.push(
        `schedule ${id}: delete failed (${e instanceof Error ? e.message : String(e)}) — the orphan guard will retire it`
      )
    }
  }

  return { ok: true, disabledBots, deletedSchedules, warnings }
}
