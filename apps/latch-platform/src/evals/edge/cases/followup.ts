/**
 * Edge Eval v0 — turn 2 of every cell (guide line 206: "automatically provide the
 * follow-up and judge the full recommendation").
 *
 * edge-v2's first turn is a short clarifier that asks ONE thing: either "is this the
 * direction you want?" or "what is the one missing constraint?". The canned follow-up
 * must answer BOTH shapes without adding facts the planes do not contain, so it confirms
 * the direction and pins the context to what the agent already knows.
 *
 * INFRA-10 carries its own follow-up from the source doc (Question.followup) and uses
 * that instead.
 */
import type { Question } from "./questions";

export const CANNED_FOLLOWUP =
  "Yes — that's the direction I want. Assume nothing has changed from what you already know about us, and give me your full recommendation now.";

export const followupFor = (q: Question): string => q.followup ?? CANNED_FOLLOWUP;
