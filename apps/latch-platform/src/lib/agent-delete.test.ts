import { createClient, type Client } from "@libsql/client"
import { beforeEach, describe, expect, it } from "vitest"
import type { LanguageModel } from "ai"
import { createAgentStore, migrateAgents } from "./agent-store"
import { createTelegramStore, migrateTelegram } from "./telegram-store"
import { createWhatsappStore, migrateWhatsapp } from "./whatsapp-store"
import { deleteAgentCascade, type AgentDeleteDeps } from "./agent-delete"
import type { AgentRecord } from "./agent-store"
import type { Principal } from "./session"

/**
 * The delete cascade over a REAL in-memory DB: the exact key shapes
 * (URL-encoded `org/user` schedule owners, bare vs `org:`/`user:`-pinned agent
 * refs, personal-wins-over-org resolution) are what the org:tankka incident
 * hinged on, so a stubbed store would test nothing.
 */

const ME: Principal = { orgId: "org1", userId: "me" }
const COLLEAGUE: Principal = { orgId: "org1", userId: "colleague" }
const OUTSIDER: Principal = { orgId: "org2", userId: "outsider" }

const ownerTag = (p: Principal) =>
  (p.userId ? [p.orgId, p.userId] : [p.orgId]).map(encodeURIComponent).join("/")

const record = (name: string, scope: "org" | "user"): AgentRecord => ({
  name,
  modelId: "m",
  instructions: "do things",
  connections: [],
  scope,
})

let client: Client
let deps: AgentDeleteDeps
let telegramStore: ReturnType<typeof createTelegramStore>
let whatsappStore: ReturnType<typeof createWhatsappStore>

async function seedSchedule(id: string, owner: Principal, agent: string) {
  await client.execute({
    sql: `INSERT INTO latch_schedules (id, owner, agent, identity, prompt, next_run_at, enabled, created_at)
          VALUES (?, ?, ?, ?, 'go', 0, 1, 0)`,
    args: [id, ownerTag(owner), agent, JSON.stringify(owner)],
  })
}

async function scheduleIds(): Promise<string[]> {
  const res = await client.execute("SELECT id FROM latch_schedules ORDER BY id")
  return (res.rows as unknown as { id: string }[]).map((r) => String(r.id))
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" })
  await migrateAgents(client)
  await migrateTelegram(client)
  await migrateWhatsapp(client)
  // Just the table the cascade touches — the full drizzle migrate drags in
  // every latch_* table for nothing.
  await client.execute(`CREATE TABLE latch_schedules (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, agent TEXT NOT NULL, identity TEXT,
    cron TEXT, timezone TEXT, prompt TEXT NOT NULL, delivery TEXT,
    next_run_at INTEGER NOT NULL, last_run_at INTEGER, enabled INTEGER NOT NULL,
    lease_owner TEXT, lease_expires_at INTEGER, created_at INTEGER NOT NULL)`)

  const agentStore = createAgentStore(client, () => ({}) as LanguageModel)
  telegramStore = createTelegramStore(client)
  whatsappStore = createWhatsappStore(client)
  deps = { agentStore, telegramStore, whatsappStore, client }
  await agentStore.upsert(ME, record("tankka", "org"))
  // Same bare name in the OTHER scope — the resolution trap.
  await agentStore.upsert(COLLEAGUE, record("tankka", "user"))
})

describe("deleteAgentCascade", () => {
  it("deletes exactly the schedules that resolved to the deleted record — org-wide, scope-aware", async () => {
    await seedSchedule("s1_mine_pinned", ME, "org:tankka")
    await seedSchedule("s2_colleague_pinned", COLLEAGUE, "org:tankka") // other member's row
    await seedSchedule("s3_colleague_bare", COLLEAGUE, "tankka") // personal-wins → their OWN tankka
    await seedSchedule("s4_mine_bare", ME, "tankka") // I have no personal tankka → the org record
    await seedSchedule("s5_other_org", OUTSIDER, "org:tankka") // different org entirely
    await seedSchedule("s6_mine_user_pin", ME, "user:tankka") // never resolved for me → orphan guard's job

    const res = await deleteAgentCascade(ME, "org", "tankka", deps)

    expect(res.ok).toBe(true)
    expect(res.deletedSchedules).toBe(3)
    expect(await scheduleIds()).toEqual([
      "s3_colleague_bare",
      "s5_other_org",
      "s6_mine_user_pin",
    ])
    // The org record is gone; the colleague's personal tankka survives.
    expect(await deps.agentStore.getRecord(ME, "org:tankka")).toBeUndefined()
    expect(
      (await deps.agentStore.getRecord(COLLEAGUE, "user:tankka"))?.scope
    ).toBe("user")
  })

  it("disables the deleted scope's bot bindings and no others, keeping the rows", async () => {
    await telegramStore.create({
      id: "bot_org",
      agent: "tankka",
      agentScope: "org",
      orgId: "org1",
      handle: "tankka_bot",
    })
    await telegramStore.create({
      id: "bot_user",
      agent: "tankka",
      agentScope: "user",
      orgId: "org1",
      handle: "personal_tankka_bot",
    })
    await whatsappStore.create({
      id: "wa_org",
      agent: "tankka",
      agentScope: "org",
      orgId: "org1",
      handle: "wa_tankka",
    })

    const res = await deleteAgentCascade(ME, "org", "tankka", deps)

    expect(res.ok).toBe(true)
    expect(res.disabledBots.sort()).toEqual([
      "telegram:tankka_bot",
      "whatsapp:wa_tankka",
    ])
    const bots = await telegramStore.listForOrg("org1")
    expect(bots.find((b) => b.id === "bot_org")?.status).toBe("disabled")
    expect(bots.find((b) => b.id === "bot_user")?.status).toBe("active")
    expect(
      (await whatsappStore.listForOrg("org1")).find((b) => b.id === "wa_org")
        ?.status
    ).toBe("disabled")
  })

  it("aborts WITHOUT deleting the agent when a binding can't be disabled", async () => {
    const failing: AgentDeleteDeps = {
      ...deps,
      telegramStore: {
        listForOrg: async () => {
          throw new Error("telegram store down")
        },
        setStatus: async () => {},
      },
    }
    const res = await deleteAgentCascade(ME, "org", "tankka", failing)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/NOT deleted/)
    expect((await deps.agentStore.getRecord(ME, "org:tankka"))?.scope).toBe(
      "org"
    )
  })

  it("a user-scope delete never reaches the org record's schedules", async () => {
    await seedSchedule("s_org_pin", COLLEAGUE, "org:tankka")
    await seedSchedule("s_user_bare", COLLEAGUE, "tankka") // resolves to their personal record

    const res = await deleteAgentCascade(COLLEAGUE, "user", "tankka", deps)

    expect(res.ok).toBe(true)
    expect(res.deletedSchedules).toBe(1)
    expect(await scheduleIds()).toEqual(["s_org_pin"])
    expect((await deps.agentStore.getRecord(ME, "org:tankka"))?.scope).toBe(
      "org"
    )
  })

  it("an unreadable identity is left for the runDue orphan guard, with a warning", async () => {
    await client.execute({
      sql: `INSERT INTO latch_schedules (id, owner, agent, identity, prompt, next_run_at, enabled, created_at)
            VALUES ('s_bad', ?, 'org:tankka', 'not-json', 'go', 0, 1, 0)`,
      args: [ownerTag(ME)],
    })
    const res = await deleteAgentCascade(ME, "org", "tankka", deps)
    expect(res.ok).toBe(true)
    expect(res.deletedSchedules).toBe(0)
    expect(res.warnings.join(" ")).toMatch(/s_bad/)
    expect(await scheduleIds()).toEqual(["s_bad"])
  })
})
