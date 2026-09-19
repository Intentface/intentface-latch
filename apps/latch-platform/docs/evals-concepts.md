# Evals: the model, and why it is shaped this way

Written after building it. Everything here was either measured or learned by
getting it wrong first; where there is a number, it came from a real run against
a real agent.

This is the *thinking*. For how the page should look, see `evals-ui-brief.md`
and `evals-ui-brief-2-shared-checks.md`. For what the code does, read the files
— they are commented.

---

## 1. The one idea

**The unit is a question, not a test.**

A test has to be RUN: spin the agent up, pay for the inference. So it only ever
tells you about the version you are on, and measuring an old version means
re-running it, which nobody does.

A question is asked of a transcript that already exists. Write one this morning
and it applies to every conversation ever stored — including the ones from
before anyone thought to ask.

That single property is why this is not a test framework with a different
vocabulary. **A question can be asked of the past.** An incident becomes a
measurement instead of an anecdote: add one sentence, and five minutes later you
know how often it happened over three months and whether it started at a
particular release.

## 2. The same question lives in three places

There is one artifact, deployed three ways. Keeping them the same thing is
deliberate; a question written for one works unchanged in the others.

| Where | Input | When |
|---|---|---|
| **Online rubric** | live traffic | every qualifying run |
| **Case check** | a synthetic input you wrote | when a set is run |
| **Trace question** | conversations already stored | whenever you ask |

A case is *a question with a synthetic input*. Nothing else about it differs —
the same `askOfTrace` call answers all three.

## 3. Three primitives, and choice is the one that matters

The evaluation contract (AI SDK `experimental_evaluate`) has exactly three
question types. Pick the one whose SHAPE matches the judgment, not the one
easiest to write:

- **boolean** — a real line. Phrase it so YES is good.
- **choice** — a failure with several *shapes*.
- **score** — a matter of degree, with named rungs worst→best.

**Why choice earns its complexity.** "Did it handle the missing region?" as a
boolean records asking-too-much, guessing-silently and refusing-outright as the
same zero — three behaviours with three different fixes, and the score cannot
say which happened. As a choice, the selected option IS the diagnosis.

Measured, live, on a real agent:

```
"Which region are you asking about?"        → asked    (1.00)  pass
"In us-east-1 the limit is 125 per VPC."    → said_so  (0.85)  pass
"It's 125."                                 → guessed  (1.00)  FAIL
```

Two passes a boolean would have recorded identically, and a failure that names
itself.

**Always give a choice an "it did not arise" option.** Real traffic is messy and
most conversations will not exercise a given promise. A question that quietly
fails whenever the topic did not come up measures the topic, not the agent.

**Keep the probability.** A verdict at 0.51 and one at 0.99 are not the same
evidence, and the difference is what eventually tells you which questions this
judge can be trusted on. (Trap: the API returns P(true). A firm "definitely not"
arrives as 0.02, which displayed naively reads as *2% confident* when the judge
is 98% sure of the opposite.)

## 4. Where a check lives: shared or per-case

- **Shared** (on the set): asked of every case. Most questions.
- **Per-case**: only where the check needs ground truth the question itself
  cannot know — *which* document, *which* number.

**This is not a convenience, it decides whether the numbers mean anything.** A
shared check over 100 inputs gets n=100 and a comparison can resolve it. A
per-case check gets n=1 and can never be conclusive: one flipped verdict is
indistinguishable from noise.

A healthy set is **5–7 shared checks and one or two per-case ones, for any
number of inputs.** A hundred per-case checks is a hundred measurements that
each say "cannot tell".

## 5. What to evaluate

**The richness of an eval is a function of the specificity of the prompt**, not
of the tooling. Measured across three real agents:

| agent | prompt | result |
|---|---|---|
| generic assistant | 475 chars | 6 promises, **5 never fired** on 19 conversations |
| hn-digest | ~750 chars | 7 promises, mostly format rules |
| edge-advisor | 7,601 chars | 7 promises incl. an isolation boundary as a named failure |

**For a specific agent**, the instructions are a list of promises and each is
checkable. **For a generic agent** you evaluate the floor, not the ceiling:
process invariants that are agent-shaped rather than domain-shaped — did it use
a tool for facts, ask when ambiguous, avoid acting destructively, answer what
was asked.

**The tools are a contract even when the prose is not.** An agent with a
`charge_customer` tool has implicit promises whether or not anyone wrote them
down. The audit finds these without being told.

**A thin audit is information about the agent, not the tool.** An agent nobody
can write five promises for is an agent nobody can tell is working — that is a
product problem surfacing as an eval problem.

## 6. Where questions come from, best first

1. **The agent's own instructions.** What it PROMISES is what is worth checking,
   and a promise nothing checks is the gap to close first. This needs no
   authoring at all — see §7.
2. **The corpus.** For each document, *what question does only this document
   answer?* gives you the input AND its answer key together.
3. **A real failure.** Turn the conversation into a case. The input is real,
   which beats one you imagined.
4. **A description you type.** Weakest, because you only think of the failures
   you have already thought of.

**Ground the author in the real prompt and real tool names**, in the brief
itself rather than telling it to go and look. An instruction to fetch is a
suggestion; a prompt containing the answer is a fact. Measured difference: given
the system prompt, the author asserted `contains: ["⬆️","💬"]` — the exact emoji
from the agent's own format rules, a free deterministic check. Without it, a
generic `news.ycombinator.com`.

## 7. The first number should cost nothing

Asking someone to write a suite before they have seen a single number is how
eval tooling goes unused. The promises are already in the prompt; the
conversations are already in the database. So the first signal needs **no
authoring, no run, and no decision to start**.

Measured on a real agent: 7 promises derived in 29 seconds, then 19 real
conversations judged in 21 calls in 38 seconds. No agent runs. Pennies.

## 8. Trusting the judge

**An unvalidated question is a vibe with a decimal point.** It may be measuring
the behaviour you meant or how the answer happened to be phrased, and the run
cannot tell the difference.

So: **an unvalidated check may REPORT; only a validated one may GATE.** Two
conditions, both necessary — enough labels (3/3 is not evidence) and high enough
agreement (right four times in five fires a false alarm on a fifth of runs,
which is how a suite stops being read).

**Keep the judge's answer beside the human's, never replace it.** The PAIR is
the evidence. A table of corrected verdicts looks tidier and answers nothing.

**Which judge is a measurement, not a procurement decision.** The contract is
standard, so the same conversations can be run through two judges and compared.
Measured over 8 real conversations: 100% agreement on one question, 63% on
another, **38% on a third**. One of them was wrong about most of those runs and
the numbers alone cannot say which — which is the entire argument for
corrections.

**You cannot referee a verdict you cannot see.** Judging the judge requires
reading the conversation — including tool RESULTS, not just tool names, since
most checks are about whether an answer came from a tool result.

## 9. Reading a comparison

**A number without an interval is not evidence.** "82% vs 79%" over sixty
conversations is a coin flip, and a team that ships on it will revert on it next
week.

Three things make a comparison real:

- **Pairing.** Compare versions on the SAME tasks. Question difficulty varies
  more than most regressions do.
- **An interval**, from a bootstrap over tasks.
- **Admitting ignorance.** `flat` and `cannot tell` are different answers, and
  collapsing them is how suites get muted.

**`UNDERPOWERED` is the correct answer most of the time**, and it is a feature.
A confident bar drawn over six observations is a more persuasive way to be
wrong than the table it replaced.

**The zero-variance trap**, which we shipped and then caught: when every pair
agrees, the bootstrap has no variance, reports a zero-width interval, and says
`flat` — "certainly no difference", from seven observations. The rule of three
gives the honest bound (no differences in n trials leaves a 95% bound of ~3/n):

```
before:  Δ=+0pp  CI=[+0pp, +0pp]   n=7  flat          ← false certainty
after:   Δ=+0pp  CI=[-43pp, +43pp] n=7  UNDERPOWERED  ← the truth
```

**Correct for multiple comparisons.** Twenty questions between two versions will
hand you a "significant" result by chance about half the time.

## 10. Overfitting

Three kinds. The third is the one nobody mentions.

**To the cases.** A per-case check has n=1; you cannot distinguish "fixed the
behaviour" from "fixed this input".

**To the judge.** Reword the prompt to dodge a judge quirk and the metric goes
green while behaviour is unchanged. Goodhart with an extra layer.

**To the agent, at authoring time.** Write questions by watching what the agent
currently does and you encode its present behaviour as correct — the suite is
then 100% green and worthless. This is why the audit derives promises from the
INSTRUCTIONS rather than from traces, and why corpus-generated cases beat
transcript-generated ones: the ground truth comes from something the agent does
not control. **Preserve this deliberately** — it erodes the first time someone
"improves" the generator by feeding it examples of good runs.

What protects you, three of which are structural:

1. **The shared/specific split.** Fix from a per-case failure, then check the
   shared rate at n=100. Flat means you learned nothing generalisable.
2. **Real traffic is a held-out set that grows by itself.** Tune on cases,
   verify on traffic.
3. **Version pinning.** Run the OLD version against the NEW cases; if it also
   passes, the case never measured the thing you fixed.
4. **The correction loop** catches judge-gaming: reliability drifts.

Rules: specific checks diagnose, shared checks and traffic decide. Write the
case BEFORE the fix. Watch for the tell — specific checks improve, shared rate
flat.

## 11. What is actually expensive

**Judging is nearly free. Running the agent is not.**

Measured: ~$0.0009 per conversation to ask three questions — about $9 for ten
thousand. Running a 5-step agent on Opus is ~$1 each, so 300 replayed
questions is ~$300 naive, ~$108 with prompt caching, ~$22 sized by the
statistics, and **$0 if you canary instead** and let real traffic be both arms.

So the design is mostly about *avoiding running the agent*: ask questions of
conversations you already paid for, and replay only when you must know before a
customer sees it.

## 12. Traps worth knowing

- **Aggregation over slices.** A long run is judged in windows. "Any slice
  failed ⇒ failed" is right for "every claim is supported" and catastrophic for
  "did it open a document?" — false of nearly every window, true of the run.
  Existence questions need `agg: "every"`.
- **Silent truncation inverts answers.** A judge shown a document cut before the
  supporting sentence correctly reports the claim unsupported — about a
  perfectly grounded answer. Mark every cut.
- **Slicing hides causes.** A window over step 180 sees the damage, not the
  step-12 decision that caused it. Overlap softens it; nothing fixes it.
- **Tool calls before narration.** A judge shown the agent's own account first
  grades the account. What it DID is evidence; what it said about it is a claim.
- **Absent is not failed.** A check that did not exist when a run happened must
  not render like a loss.

## 13. Deliberately not built

- **A hosted service.** The questions live in your database next to the
  conversations, tied to agent versions and drafts. Shipping traffic elsewhere
  is the thing this is an alternative to.
- **Making `UNDERPOWERED` look decisive.**
- **Reducing a choice verdict to pass/fail anywhere.**
- **A `parked` third verdict state** for low-confidence answers — a good idea
  (borrowed from Stanley's "empty findings is not approval"), not yet done. It
  would also give corrections a priority queue, since uncertain verdicts are
  where a human ruling carries the most information.
- **A code-first path.** Everything here is a database row authored through a
  page. For hosts consuming `@intentface/latch-*` there is nothing, and that is
  the largest known gap.
