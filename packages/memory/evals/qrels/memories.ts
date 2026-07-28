/**
 * The reference memory-file set: what a good extractor SHOULD have produced
 * from the synthetic week. One markdown file per memory with
 * name/description/type frontmatter. The `.md` fixtures under
 * `fixtures/memory-files/` are rendered from these definitions (single source
 * of truth); the determinism test asserts the committed files match.
 *
 * Where the corpus contains a contradiction/supersession pair, the memory
 * reflects the CANONICAL side only (plus the correction trail in the body).
 */

export type MemoryType = "goal" | "preference" | "fact" | "constraint" | "event";

export interface MemoryFileDef {
  /** kebab-case; also the fixture filename (`<name>.md`). */
  name: string;
  type: MemoryType;
  description: string;
  body: string;
}

/** Render one memory definition to its committed `.md` fixture (frontmatter + body). */
export function renderMemoryFile(def: MemoryFileDef): string {
  return [
    "---",
    `name: ${def.name}`,
    `description: ${def.description}`,
    `type: ${def.type}`,
    "---",
    "",
    def.body,
    "",
  ].join("\n");
}

export const MEMORY_FILES: readonly MemoryFileDef[] = [
  {
    name: "race-riverdale-spring-10k",
    type: "event",
    description: "Registered for the Riverdale Spring 10K on 2026-04-18.",
    body: "Jamie is registered for the Riverdale Spring 10K on April 18, 2026. Registration was confirmed on 2026-03-02, giving roughly seven weeks of focused build. This race anchors the current training block.",
  },
  {
    name: "goal-sub-48-spring-10k",
    type: "goal",
    description: "Current race goal: finish the Spring 10K under 48 minutes (raised from sub-50).",
    body: "Jamie's target for the Riverdale Spring 10K is sub-48. The original goal was under 50 minutes; Jamie deliberately raised it on 2026-03-07 after a strong first training week. Canonical goal: 48:00 or faster.",
  },
  {
    name: "long-runs-on-sunday",
    type: "preference",
    description: "Long runs happen on Sunday mornings; Saturdays are family swim mornings.",
    body: "From 2026-03-08 onward, Jamie's long runs move to Sunday. Saturdays are reserved for family swim mornings, superseding the earlier Saturday-long-run arrangement.",
  },
  {
    name: "strength-once-per-week",
    type: "preference",
    description: "One strength session per week during race prep (reduced from two).",
    body: "During the 10K race-prep block Jamie does one focused strength session per week, reduced from two on 2026-03-08 to keep the legs fresher.",
  },
  {
    name: "achilles-flare-history",
    type: "fact",
    description: "Left achilles has flared on and off since an episode two years ago; monitor loading.",
    body: "Jamie's left achilles has been intermittently cranky since a flare-up two years ago. Disclosed on 2026-03-04, correcting an earlier claim of no injuries. Calf-heavy and hill work should be introduced carefully, and achilles status checked after hard sessions.",
  },
  {
    name: "runs-four-times-weekly",
    type: "fact",
    description: "Realistic training frequency is four runs per week.",
    body: "Jamie averages four runs per week; six happens only in a perfect week. Self-corrected on 2026-03-06 from an earlier six-days-a-week claim. Plans should assume four total runs per week.",
  },
  {
    name: "recent-10k-benchmark",
    type: "fact",
    description: "Most recent 10K benchmark is 55:40 (autumn 2025), corrected from a misremembered 52:00.",
    body: "Jamie's last 10K, run in autumn 2025, took 55:40 according to the watch record. Jamie initially misremembered it as 52 minutes and corrected the figure on 2026-03-06. Training paces derive from 55:40.",
  },
  {
    name: "no-caffeine-after-noon",
    type: "preference",
    description: "Avoids caffeine after noon; dropping the afternoon espresso fixed disrupted rest.",
    body: "Jamie cut caffeine after noon during the first training week and rest quality improved immediately. This replaces the earlier belief that caffeine had no effect. Standing habit from 2026-03-07 onward.",
  },
  {
    name: "owns-heart-rate-strap",
    type: "fact",
    description: "Owns a chest heart-rate strap; tempo efforts average around 152 bpm.",
    body: "Jamie trains with a heart-rate chest strap (first reported reading: 152 bpm average for a tempo on 2026-03-05). An earlier remark about not owning a monitor is outdated.",
  },
  {
    name: "quarter-close-evenings-blocked",
    type: "constraint",
    description: "Evenings are unavailable for training during the quarter-close month at work.",
    body: "March 2026 is the busiest quarter-close period at Jamie's job, so evening training is impossible this month. Quality sessions belong in the mornings. Corrects the earlier 'work is quiet' remark.",
  },
  {
    name: "prefers-metric-units",
    type: "preference",
    description: "Logs distance in kilometers and pace in minutes per kilometer.",
    body: "Jamie consistently reports kilometers and min/km paces (8 km at 6:00/km, 5:20/km, 34 km weekly volume). Give all distances and paces in metric units.",
  },
  {
    name: "trains-early-morning",
    type: "preference",
    description: "Runs early, before work — usually out between 5:45 and 6:15.",
    body: "Jamie heads out early, typically between 5:45 and 6:15, and likes finishing before the first meeting. Mornings are the default training slot; schedule quality sessions there.",
  },
  {
    name: "prefers-bullet-plans",
    type: "preference",
    description: "Wants training plans as short bullet lists without long explanations.",
    body: "Jamie repeatedly asks for the plan as a compact bullet list ('just the list', 'skip the explanations', 'a list I can screenshot'). Deliver schedules as terse bullets.",
  },
  {
    name: "easy-pace-six-minutes",
    type: "fact",
    description: "Comfortable easy pace is around 6:00 per kilometer.",
    body: "Easy runs at roughly 6:00/km feel comfortable for Jamie (reported 2026-03-02 on the river loop). Use ~6:00/km as the easy-run anchor until fitness shifts.",
  },
  {
    name: "tempo-pace-four-fifty",
    type: "fact",
    description: "Controlled tempo pace is around 4:50 per kilometer.",
    body: "Jamie held 4:50/km for the tempo portion on 2026-03-05 and described it as controlled. Use ~4:50/km for threshold work, revisit after the next benchmark.",
  },
  {
    name: "favorite-route-river-loop",
    type: "fact",
    description: "Favorite route is the river loop, used for easy and long runs.",
    body: "The river loop is Jamie's go-to route for easy runs and Sunday long runs. Mentioned repeatedly and described as gorgeous on quiet mornings.",
  },
  {
    name: "shoes-cloudfoam-peak-3",
    type: "fact",
    description: "Runs in the Cloudfoam Peak 3 — third consecutive pair.",
    body: "Jamie's current trainers are the Cloudfoam Peak 3, the third pair in a row. The model has proven reliable; no change needed unless a gait check suggests otherwise.",
  },
  {
    name: "office-gym-treadmill",
    type: "fact",
    description: "Has treadmill access at the office gym for rainy days.",
    body: "Jamie can use the treadmill at the office gym when weather is bad (used for the 2026-03-05 tempo). A valid venue for quality sessions.",
  },
  {
    name: "vegetarian-pre-run-fueling",
    type: "fact",
    description: "Eats vegetarian; pre-run meals are typically oats or rice and beans.",
    body: "Jamie eats vegetarian. Usual pre-run fueling is oats, or rice and beans, taken 2-3 hours before a session and lighter before hard workouts.",
  },
  {
    name: "sleep-target-seven-and-a-half",
    type: "preference",
    description: "Protects about 7.5 hours of sleep; evening sessions must not run late.",
    body: "Jamie protects roughly 7.5 hours of sleep per night, so evening commitments must stay short and end early. Rest quality improved noticeably during week one.",
  },
  {
    name: "foam-rolls-after-hard-runs",
    type: "preference",
    description: "Foam rolls calves for ten minutes after hard runs.",
    body: "After hard sessions Jamie foam rolls the calves for about ten minutes — an established habit worth keeping given the achilles history.",
  },
  {
    name: "electrolytes-on-long-runs",
    type: "preference",
    description: "Carries electrolyte tabs on long runs.",
    body: "Jamie always carries electrolyte tabs on long runs. Standing hydration habit; assume it when planning long-run fueling.",
  },
  {
    name: "work-trip-treadmill-window",
    type: "constraint",
    description: "Work trip Tue-Thu 2026-03-10 to 2026-03-12; hotel treadmill only. Time-bound.",
    body: "Jamie travels for work from Tuesday 2026-03-10 through Thursday 2026-03-12 with only a hotel treadmill available. Time-bound: expires after 2026-03-12.",
  },
  {
    name: "physio-northside-achilles",
    type: "fact",
    description: "Works with Northside Physio for achilles maintenance (visit on 2026-03-07).",
    body: "Jamie sees Northside Physio to manage the achilles, with an assessment on 2026-03-07 during the 10K build. Physio guidance informs how calf loading is progressed.",
  },
];
