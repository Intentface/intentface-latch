/**
 * Edge Eval v0 — the raw test set, verbatim from the Loredex doc "Edge test set"
 * (file_zlRNK7ffUHnwmvtQG09K1, version 3, read 2026-09-11). 68 questions — the plan's
 * "75" was a miscount: INSIGHTS 3 (no -03), INFRA 28, AX 24, CODE 13.
 *
 * Nothing here is a case yet (guide Step 2): a case adds the contract — required client
 * facts, expected shape, forbidden behaviours, weights, split. This file is the input.
 *
 * `author` is the parenthetical in the source; questions without one are marked
 * "unattributed" rather than guessed. `register` separates the client-team questions
 * (a team asking Edge for strategy) from the seven Finnish END-USER questions (a
 * client's users asking about a platform) — a different register the plan keeps out of
 * the headline until the pilot says otherwise.
 */

export type Category = "INSIGHTS" | "INFRA" | "AX" | "CODE";
export type Register = "client-team" | "end-user";

export interface Question {
  id: string;
  category: Category;
  text: string;
  /** Present only for INFRA-10, which the source pastes as a two-turn exchange. */
  followup?: string;
  author: string;
  language: "en" | "fi";
  register: Register;
}

const q = (
  id: string,
  text: string,
  author = "unattributed",
  extra: Partial<Pick<Question, "followup" | "language" | "register">> = {},
): Question => ({
  id,
  category: id.split("-")[0] as Category,
  text,
  author,
  language: extra.language ?? "en",
  register: extra.register ?? "client-team",
  ...(extra.followup ? { followup: extra.followup } : {}),
});

export const QUESTIONS: readonly Question[] = [
  // ── INSIGHTS ─────────────────────────────────────────────────────────────
  q("INSIGHTS-01", "If you could only choose and fund one meaningful agentic product feature or agent infra improvement this quarter, what would you choose? Why?"),
  q("INSIGHTS-02", "We've been telling clients we'll ship more agentic features soon, but we don't have solid initiatives lined up or a sharp AI strategy. What should we do?"),
  q("INSIGHTS-04", "My board asks what we're doing with AI. What's the 2-minute answer I should give them?"),

  // ── INFRA ────────────────────────────────────────────────────────────────
  q("INFRA-01", "Should we use LangChain or Mastra? Why?"),
  q("INFRA-02", "How would you add durable execution to our agent steps without over-engineering it?"),
  q("INFRA-03", "There's demand for an official MCP server. Should we make that an AI priority this quarter?"),
  q("INFRA-04", "We're using Gemini models directly from the Google API. Are we running behind? Should we change to another provider? Which, and why?"),
  q("INFRA-05", "Everyone's talking about multi-agent. What's the point? Should we be doing it?"),
  q("INFRA-06", "Our agent-step responses are okay, but we can't tell whether prompt changes make them better. What should we build first?"),
  q("INFRA-07", "We can build an eval set, but what exactly should we score?"),
  q("INFRA-08", "Are we in good shape on AI security?"),
  q("INFRA-09", "We keep running into the same things with our agents — no run visibility, context/token limits, multi-tenancy, retries. Should we buy agent infrastructure for this rather than keep building it?"),
  q("INFRA-10", "How should we evolve our pricing for the agentic features we've shipped?", "unattributed", {
    followup: "Okay — give me your actual recommendation. How should we evolve pricing for those features over the next 12 months?",
  }),
  q("INFRA-11", "How would we get our agent evals and traces into Langfuse in practice?"),
  q("INFRA-12", "How should we build a Slack integration safely?"),
  q("INFRA-13", "Do we need some agent runtime?", "Valtteri"),
  q("INFRA-14", "How do we limit the agent token usage?", "Valtteri"),
  q("INFRA-15", "Our customers want the assistant in a shared chat channel where people have very different permissions in our product. Whose permissions does it answer with?", "Joni"),
  q("INFRA-16", "Who owns the bot and its scopes once it's been invited into dozens of channels?", "Joni"),
  q("INFRA-17", "Could someone post a message in the channel that makes the bot do something other than what it was asked?", "Joni"),
  q("INFRA-18", "Is a chat integration a three-week job or a three-month one?", "Joni"),
  q("INFRA-19", "Are the AI agent chats private? Are they used as training data?", "Aleksi"),
  q("INFRA-20", "Which providers comply with GDPR?", "Aleksi"),
  q("INFRA-21", "How does EU AI Act affect our products? What do we need to keep in mind when developing user facing AI systems?", "Aleksi"),
  q("INFRA-22", "Should we build subagents for the main agent or keep everything (tools, context, etc.) on the main agent? At which point is it viable to add subagents?", "Joonatan"),
  q("INFRA-23", "Should the agents run in sandboxes or isolated environments?", "Joonatan"),
  q("INFRA-24", "On whose permissions is the agent working?", "Joonatan"),
  q("INFRA-25", "What should be observed in agentic processes?", "Jere"),
  q("INFRA-26", "Server/backend requirements for streaming and real-time communications? (e.g. SSE vs websockets, PHP-FPM pooling, max connections, request processing time, long-running tasks)", "Klaus"),
  q("INFRA-27", "How to minimize the blast radius of an agent running in production application gone haywire?", "Lauri"),
  q("INFRA-28", "Missä mun datat on? meneekö ne kaikille malleille? voinko poistaa omat data jos lopetan käytön? onko jollain muulla pääsy mun dataan? käytetäänkö sitä mallien koulutukseen? missä fyysisesti mun data pyörii? onko se eu ai act compliant? onko mun data turvassa jos vertaa vaikka google drive?", "Tuomas", { language: "fi", register: "end-user" }),

  // ── AX ───────────────────────────────────────────────────────────────────
  q("AX-01", "Our assistant can create, update and delete records. Should we ask for confirmation before every write so customers trust it?"),
  q("AX-02", "We want the agent to remember things like a user's preferred output format and how they tend to make decisions. What should it remember, and how should that memory experience work?"),
  q("AX-03", "What should users see while an agent run is happening, and after it's done?"),
  q("AX-04", "Our agents live in the chat window. Fine for one-offs, but for ongoing sessions and recurring jobs it feels off. What should we do?"),
  q("AX-05", "How much control should we give users over what an agent does before asking for approval?"),
  q("AX-06", "Do subagents block main thread?", "Valtteri"),
  q("AX-07", "How we surface approvals from subagents to users or main thread?", "Valtteri"),
  q("AX-08", "We want the agent to actually do things, not just answer. Where should it stop and ask permission?", "Joni"),
  q("AX-09", "If the user can undo anything the agent did, do we still need approvals?", "Joni"),
  q("AX-10", "The agent would need data we can't legally or practically put in the system. Does that kill the idea?", "Joni"),
  q("AX-11", "How do we keep the agent's warnings from becoming noise nobody reads?", "Joni"),
  q("AX-12", "If the user signs off on an agent action, are we covered?", "Joni"),
  q("AX-13", "The agent is as clueless on day 90 as on day 1. How do we design memory so it stays legible instead of drifting?", "Joni"),
  q("AX-14", "If the agent learns from one person's way of working, does it apply for their colleague?", "Joni"),
  q("AX-15", "What happens when a user's own instruction contradicts the company playbook?", "Joni"),
  q("AX-16", "Users get annoyed even when the agent is right. What's actually going wrong?", "Joni"),
  q("AX-17", "Should we just build an MCP on top of existing product and not integrate a chat UI into it?", "Joonatan"),
  q("AX-18", "How do we teach the agent our vocabulary and practises?", "Lauri"),
  q("AX-19", "Onko jotain muita ai käyttöliittymiä kuin chatti? Minkälaisia?", "Tuomas", { language: "fi", register: "end-user" }),
  q("AX-20", "Miten yhdistän eri palveluita omaan ai plattaan esim hr, crm jne? Jos yhdistän eri plattaan niin meneekö mun tiedot myös plattaan vai toimiiko tiedonsiirto vaan toiseen suuntaan? Voiko tämän itse valita? tallentuuko mun tiedot kaikille mallitarjoajilla?", "Tuomas", { language: "fi", register: "end-user" }),
  q("AX-21", "pitääkö mun aina itse promptata tai käskeä ai plattaa tekemään asioita? voiko automatioida? miten voi automatisoida?", "Tuomas", { language: "fi", register: "end-user" }),
  q("AX-22", "our user was asking: \"jos kaikki käyttää samaa plattaa niin onko riksi että jengi muokkailee samoja faileja tai vaihtaa niiden lokaatioita ja sitten kaikki menee sotkuun?\", what should we do about it", "Tuomas", { language: "fi", register: "end-user" }),
  q("AX-23", "mitä jos haluan että joku näkee jotain joka rajoitetaan toiselta? rakentaako ai platta konteksin kaikesta datasta vai vaan siitä mihin yksilöllä on pääsy? voiko tämä johtaa erilaisiin lopputuloksiin samoista toimenksiannoista?", "Tuomas", { language: "fi", register: "end-user" }),
  q("AX-24", "Mistä ai platta tietää mitä minä juuri haluan tehdä? Jos minä käytän ai plattaa tietyllä tavalla niin tallentuuko se myös muille niin että meidän ai platta mukailee kaikkien käyttäjijen keskiarvokäytöstä ja onko se persoonallinen jokaiselle käyttäjälle?", "Tuomas", { language: "fi", register: "end-user" }),

  // ── CODE ─────────────────────────────────────────────────────────────────
  q("CODE-01", "How should we review AI-generated code?"),
  q("CODE-02", "How to make sure blast radius is small enough, sandboxed envs?", "Valtteri"),
  q("CODE-03", "Our PRs doubled in size and our reviewer says he's skimming, not reviewing. How should we review AI-generated code?", "Joni"),
  q("CODE-04", "Our test coverage is thin and our conventions live in one person's head. Are we doing this in the wrong order?", "Joni"),
  q("CODE-05", "Who decides what counts as critical code, and where is that written down?", "Joni"),
  q("CODE-06", "If AI reviews AI-generated code, what's the independent part?", "Joni"),
  q("CODE-07", "How should AI systems be tested?", "Aleksi"),
  q("CODE-08", "What common skills should we add on repo?", "Joonatan"),
  q("CODE-09", "How can I effectively control agent context during development process?", "Jere"),
  q("CODE-10", "How do we control the massive number of PRs generated as agentic coding multiplies development capacity?", "Jere"),
  q("CODE-11", "How do you work on multiple things simultaneously with Claude Code (or agents)?", "Klaus"),
  q("CODE-12", "Should I allow git access, what to allow / deny?", "Klaus"),
  q("CODE-13", "How to allocate human review resources efficiently (how to identify risky areas where mistakes are expensive)?", "Klaus"),
];

export const byId = (id: string): Question => {
  const found = QUESTIONS.find((x) => x.id === id);
  if (!found) throw new Error(`unknown question ${id}`);
  return found;
};

export const CATEGORIES: readonly Category[] = ["INSIGHTS", "INFRA", "AX", "CODE"];
