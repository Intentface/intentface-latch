# Evals, in one page

The short version of everything. `evals-concepts.md` is the reasoning and the
measurements; this is the frame to keep in your head while working.

---

## The one idea

**The unit is a question, not a test.**

A test has to be *run*: spin the agent up, pay for the inference. It can only
ever tell you about the version you are on.

A question is *asked of a conversation*. Write one this morning and it applies
to every conversation ever stored, including the ones from before anyone
thought to ask.

Everything below follows from that.

---

## What a dataset actually is

Not "prompts and their expected outputs". Three separate things, and confusing
them is what makes evals feel impossible:

| | What it is | Where it comes from |
|---|---|---|
| **Inputs** | What gets sent to the agent | Mostly your real traffic |
| **Questions** | What you ask about what happened | Mostly the agent's own promises |
| **Rulings** | A human saying the judge was right or wrong | You, on verdicts you doubt |

**You almost never need an expected output.** "Is every claim in the answer
supported by something a tool returned?" is answerable by reading the
transcript. Nobody has to know in advance what the right answer was.

That is the thing that makes this affordable. The moment a framework demands an
expected output per input, authoring becomes the bottleneck and the suite never
gets written.

---

## The split that organises everything

Questions divide on one criterion: **does answering it require knowing
something the conversation does not contain?**

**No → the question is SHARED.** Asked of every input.
> *Is every specific fact present in a tool result from this conversation?*

Self-contained. Means the same thing whatever the user asked. One observation
per input, so 100 inputs gives you n=100.

**Yes → the question belongs to ONE INPUT.** It carries ground truth.
> *Did it open `docs/networking/vpc-limits.md`?*

Meaningless for any other input. Exactly one observation, forever.

This is not a filing convenience. It decides whether your numbers can conclude
anything. A shared question at n=100 can resolve a regression. A per-input
question at n=1 cannot distinguish a real change from noise, ever.

**A healthy suite is 5–7 shared questions and one or two per-input ones — for
any number of inputs.** If you have written the same question onto twelve
cases, you wanted a shared one.

---

## Ten statements

1. **Phrase every question so YES is good.** Then failure is always the same
   direction and nobody has to remember which.

2. **A question must be answerable from the transcript alone.** If it is not,
   it needs ground truth, and ground truth makes it per-input — which costs you
   the statistics. Try to rephrase before you accept that.

3. **Use a choice when failure has shapes.** "Did it handle the missing region?"
   as yes/no records *asked too much*, *guessed silently* and *refused outright*
   as the same zero — three behaviours with three different fixes. As a choice,
   the option it picked **is** the diagnosis.

4. **Always give a choice a "did not arise" option.** Most conversations will
   not exercise a given promise. A question that fails whenever the topic did
   not come up is measuring the topic, not the agent.

5. **Expected output is for the deterministic parts only.** Was this tool
   called, with these arguments. Was this tool *not* called. String-matching a
   generative answer fails on paraphrase and passes on confident nonsense.

6. **More inputs, not more questions.** The common failure is fifty cases each
   with its own bespoke check: fifty measurements that each say "cannot tell".

7. **Never write questions by watching what the agent currently does.** That
   encodes present behaviour as correct, and the suite goes green and stays
   worthless. Derive them from what it *promised*, or from your corpus.

8. **Keep the judge's answer and the human's side by side.** Never overwrite.
   The pair is the only thing that can answer whether this judge is any good at
   this question.

9. **An unvalidated question may report. Only a validated one may gate.**
   Ten rulings at 90% agreement. Until then it is a vibe with a decimal point.

10. **`UNDERPOWERED` is usually the correct answer, and it is not a bug.** A
    handful of cases cannot separate a real change from noise. A confident bar
    over six observations is a more persuasive way to be wrong than the table
    it replaced.

---

## How to start, cheapest first

Do these in order. Each rung gives you something before you climb the next.

**0. Ask the agent what it promises.** Its instructions are a list of promises.
Derive questions from them and ask those of conversations it has already had.
No authoring, no runs, a number in under a minute. *Measured: 7 promises in 29
seconds, then 19 stored conversations judged in 38 seconds, for pennies.*

**1. Keep the good ones as shared questions.** They are already shared-shaped —
derived from instructions, carrying no per-input ground truth.

**2. Take inputs from something that already exists.**
   - **Real traffic.** Free, real, and the failures are already known.
   - **Your corpus.** For each document, ask *what question does only this
     document answer?* — that gives you the input and the answer key together.
     This is the only cheap source of ground-truth questions.
   - **An incident.** One real failure becomes one case. The input is real, and
     you already know what it should have done — that is why you noticed.
   - **Your imagination.** Last, and only for a scenario you fear but have not
     seen. You can only imagine the failures you have already thought of.

**3. Add per-input questions only where a shared one cannot reach.**

**4. Rule on verdicts you doubt.** Open the conversation, read the tool
results, say whether the judge was right. This is the only step that converts a
number into a measurement.

**5. Only now, gate a release on it.**

---

## How big does it need to be?

Set by the smallest change you want to notice, and driven by the **shared**
questions — a per-input question is n=1 however many you write.

| To detect | Inputs, roughly |
|---|---|
| a 20pp change | ~30 |
| a 10pp change | ~100 |
| a 5pp change | ~400 |

If that looks expensive, remember what is actually expensive. Judging is
~$0.0009 a conversation. Running the agent is ~$1. Which is the argument for
asking questions of traffic you have already paid for, and replaying only when
you must know before a customer sees it.

---

## Three questions to ask of every question, before you write it

1. **Can a careful reviewer answer this from the transcript alone?**
   No → it needs ground truth → it is per-input → accept n=1 or rephrase.
2. **Does it mean the same thing for every input?**
   Yes → make it shared. This is the default and should feel like the easy path.
3. **Will it actually fire?**
   Rarely → it is measuring the topic, not the agent → give it an escape option.

---

## Smells

- **Every case has its own checks.** You have written n=1 measurements. Nothing
  will ever be conclusive.
- **The suite is 100% green.** Either it was written by watching the agent, or
  it is measuring nothing. Both are the same problem.
- **A shared rate stayed flat after you fixed a per-case failure.** You fixed
  that input, not the behaviour.
- **A question nobody has ever ruled on is gating a release.** You are blocking
  deploys on an unvalidated opinion.
- **Nobody can write five promises for the agent.** That is not an eval problem
  surfacing. That is a product problem surfacing *as* an eval problem.

---

## The two-sentence version

*Write down what the agent promises, as questions a reader could answer from
one conversation. Ask them of the conversations you already have, rule on the
answers you doubt, and only trust the ones that have earned it.*
