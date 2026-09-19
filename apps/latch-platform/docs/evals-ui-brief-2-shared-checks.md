# Evals UI — brief 2: shared vs per-case checks

Read `evals-ui-brief.md` first. This one covers a single idea that changes the
shape of the whole page, and it is the part most likely to be designed wrong.

---

## The idea

A **check** is a judged question. Checks live in one of two places:

- **Shared** — on the SET. Asked of every case. *"Is every claim supported by a
  tool result?"* means the same thing whatever the user asked.
- **Per-case** — on ONE case. Asked only of that input. *"Did it open
  `docs/networking/vpc-limits.md`?"* is meaningless for any other input.

A case with 4 of its own, in a set with 2 shared, is judged on **6 checks**. Ids
merge case-last, so a case can redefine a shared id to sharpen it for its own
input.

In practice a healthy set is **5–7 shared checks and one or two per-case ones,
for any number of inputs.** If someone has written the same question on twelve
cases, they wanted a shared check.

## Why the distinction is load-bearing

Not a convenience. It decides whether the numbers mean anything:

- A **shared** check gets one observation per case. 100 inputs → **n=100**, and
  the version comparison can resolve it.
- A **per-case** check gets **n=1**. It can never be conclusive on its own — one
  flipped verdict is indistinguishable from noise.

So the rule is: a check goes on a case **only** when it needs ground truth the
question itself cannot know (which document, which number). Everything else is
shared. The UI should make that the path of least resistance.

---

## The four design problems this creates

### 1. A check inside a case has two possible homes, and editing has different blast radius

Opening a case shows six checks. Two of them, if edited, change **every case in
the set**. Four change only this one. Today there is nothing distinguishing
them — they are the same widget in the same list.

That is a dangerous affordance. Someone tuning a question for one awkward input
can silently retune it for ninety-nine others.

Design for: *where does this check live, and what will editing it touch?* being
answerable at a glance, without a tooltip.

### 2. Override is powerful and invisible

A case can redefine a shared id — deliberately, to sharpen a shared question for
its own input. That is a good feature and an excellent way to confuse someone:
the set says one thing, this case behaves differently, and nothing says so.

An overridden check needs to read as *"the shared question, changed here"* —
including a way back to what the shared version says.

### 3. The results grid does not survive this

Current grid: checks down the side, runs across. With shared checks that becomes
**shared checks × cases** rows — 7 shared over 100 cases is 700 rows of mostly
identical ticks. Unusable, and it buries the per-case rows that carry the ground
truth.

The natural shape is probably two sections, but this is the open design question
and worth real thought:

```
shared                        v6        v7
  grounded-in-tools        94/100     91/100      ← aggregate, one row
  answered-the-question   100/100    100/100

per-case
  vpc-limits · reads-doc        ✓          ✓      ← one row per case+check
  billing-q  · reads-doc        ✓          ✗
```

A shared check's value at 100 inputs is a **rate**, not a tick. A per-case
check's value is a tick, because there is only one. Those want different
treatments, and forcing both into one table is what breaks.

Drilling from an aggregate into the cases that failed it is the important
interaction — "91/100, show me the nine".

### 4. Cost is invisible and multiplies

Adding one shared check adds one judge call per case per run. Seven shared over
a hundred inputs is 700 calls a run. It is cheap (~70 cents) but it is the thing
people forget, and it scales with the set while a per-case check does not.

The panel currently prints `N verdicts per run`. That is a placeholder, not a
design — but the information should survive whatever replaces it.

---

## An action that should exist and does not

The **audit** (brief 1, §3) derives questions from the agent's own instructions
and asks them of real conversations. Those questions are *already shared-shaped*
— they are asked of every conversation, they carry no per-input ground truth.

So "promote this audited promise into a shared check" is the natural bridge from
the zero-setup first look to a real suite, and there is no way to do it. Someone
currently has to retype the question.

If you design one new interaction, make it this one.

---

## Constraints specific to this brief

- **Do not hide the distinction to make the page simpler.** Merging shared and
  per-case into one undifferentiated list is the obvious simplification and it
  removes the only thing that makes the numbers trustworthy.
- **Do not make per-case the default path.** It is the exception. A UI that
  makes adding a check to a case easier than adding it to the set will produce
  suites of n=1 measurements that can never conclude anything.
- Shared checks are edited in one place and read in many. Whatever you do, a
  reader inside a case must be able to see the shared ones without leaving.

## Where the code is

| What | Path |
|---|---|
| `EvalSet.checks` (shared) and `EvalCase.checks` (per-case) | `src/lib/evals/store.ts` |
| Merge rule (`{ ...shared, ...case }`) | `src/lib/evals/run.ts` |
| Shared panel + case list + grid | `src/routes/evals.tsx` |

Real data to design against: the `hn-digest` set has 2 shared checks and 3 cases
with 4, 1 and 1 of their own — 12 verdicts per run. Small, but it exercises
every state including an override.

## How to know it worked

1. Someone can tell, without clicking, which checks in a case are shared.
2. Someone editing a shared check knows it affects every case before they type.
3. A set with 100 inputs and 7 shared checks produces a results view that fits
   on a screen and still answers "which nine failed".
4. Adding a check to the SET is at least as easy as adding one to a case.
