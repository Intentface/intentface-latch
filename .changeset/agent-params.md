---
"@intentface/latch-core": minor
"@intentface/latch-drizzle": minor
"@intentface/latch-server": minor
---

**Params: what a chat is about.** An agent can declare `params` with a schema (Zod, Valibot, any Standard Schema): `defineAgent(fn, { params: z.object({ ticketId: z.string() }) })`. The chat's first message passes them (`handleChat({ …, params })`, also `runAgent` and `schedule`). They're validated, saved on the chat, and given to the agent function and to tools (`context.params`) on every turn: later messages, the continuation after an approval, crash recovery, and schedule fires. Later messages don't send them again; the same params again are fine, different ones are refused (`ParamsFixedError`, 409). An agent without a schema refuses params (`InvalidParamsError`, 400).

**`context` is a plain function**: `createRuntime({ context: async ({ principal }) => ({ … }) })`, and it's optional. `defineContext({ build })` still works but is deprecated, as are `turnContext` and `request`, which are missing when an answer continues.

**`agent` is optional for a continuing chat**: `handleChat` uses the agent the chat was started with.

**Storage:** chats and schedules get a `params` column (`migrate` / `migratePostgres` add it). A custom adapter should store `params` on `createChat` and `createSchedule` and return it; the conformance kit now checks chats.
