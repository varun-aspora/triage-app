# Eval practice, framework-neutral

The depth behind SKILL.md: how to find out what's broken, build the dataset,
design graders, align a judge, and keep the suite alive. Nothing here is tied
to a framework.

- [Where evals fit](#where-evals-fit)
- [Vocabulary](#vocabulary)
- [Error analysis](#error-analysis)
- [The annotation viewer](#the-annotation-viewer)
- [Building the dataset](#building-the-dataset)
- [Eval awareness](#eval-awareness)
- [Specifying a task](#specifying-a-task)
- [Grader design](#grader-design)
- [Building an LLM judge you can trust](#building-an-llm-judge-you-can-trust)
- [The harness](#the-harness)
- [Metrics](#metrics)
- [Agent-type notes](#agent-type-notes)
- [Keeping the suite alive](#keeping-the-suite-alive)
- [What has aged, and what hasn't](#what-has-aged-and-what-hasnt)

## Where evals fit

### Three levels, in order

**Level 1 — assertions.** Cheap, deterministic checks that run on every change:
output parses, array length matches the scenario, no internal UUID leaked into
user-facing text, the required tool was called. Fast enough to run constantly.
Get most of the way through Level 1 before starting Level 2 — assertions are
less work and they never drift.

**Level 2 — human and model evaluation.** Logged traces, a review interface, a
human verdict, and eventually an LLM judge aligned to that human. This is where
the failures assertions can't express get caught.

**Level 3 — A/B testing.** Real users, real outcomes. Only meaningful once the
product is stable enough that a change is worth exposing.

### And alongside them

| Method | Gives you | Misses |
| --- | --- | --- |
| Automated evals | Fast iteration, reproducible, gates CI | Only what you anticipated; can create false confidence |
| Production monitoring | Real behaviour at scale, surprising failures | Reactive, noisy, no ground truth |
| A/B testing | Actual outcomes, controlled | Slow; only tests what's already shipped |
| User feedback | Problems nobody predicted | Sparse, skewed to severe cases |
| Manual transcript review | Intuition and calibration | Doesn't scale |
| Human studies | Gold-standard labels for subjective work | Expensive, slow |

No single layer catches everything. The point of having several is that what
slips through one is caught by another.

## Vocabulary

Worth being precise about, because these get muddled in review:

- **Task / case** — one test with inputs and success criteria.
- **Trial** — one attempt at a task. Multiple trials handle nondeterminism.
- **Grader** — the logic that scores a trial. A task can have several.
- **Transcript / trace / trajectory** — the full record: outputs, tool calls,
  reasoning, intermediate state.
- **Outcome** — the final state of the environment after the trial.
- **Harness** — the infrastructure that runs trials and aggregates results.
  Distinct from the *agent harness*, the scaffold the model runs in.
- **Suite** — a set of tasks measuring one capability or protecting one
  behaviour.

## Error analysis

The activity that produces everything else. Teams that skip it build
dashboards of metrics that improve while users stay unhappy.

### Bottom-up, not top-down

Top-down means starting from a list of categories — hallucination, toxicity,
relevance — and counting how often each occurs. You will find what you brought
with you, and the categories that actually matter in your domain ("quotes the
list price instead of the contracted rate") aren't on the generic list.

Bottom-up means reading traces first and letting the categories emerge. It is
slower to start and it is the one that works.

### The loop

**1. Open coding.** Read a trace, write a free-form sentence about what went
wrong. No taxonomy yet. Be specific and concrete — "asked for the ticket ID
when it was already in the conversation" is useful, "poor context handling" is
not yet.

**2. Axial coding.** Once you have fifty to a hundred notes, cluster them into
failure modes. An LLM does this well: paste the notes, ask for recurring
categories with representative examples. Review the clustering yourself — this
is where you learn what your product's actual problems are, and outsourcing
the reading defeats the purpose.

At production scale this stops being a hand operation. Past several thousand
traces, have the model cluster and propose failure-mode tags, then review at
the *cluster* level rather than the trace level: confirm or rename each
category, and spot-check members. Where the tags matter enough to act on, have
two people label a sample independently and check inter-rater agreement
(Cohen's kappa above ~0.6 before you trust the taxonomy). Automated tags
nobody validated drift away from reality without any visible symptom.

**3. Count.** Frequency per failure mode. Then split by dimension — feature,
scenario, persona — because an 8% overall failure rate that is 40% for one
scenario is a different problem than one spread evenly. Rank by frequency ×
business impact; the most common failure is not always the one worth fixing
first.

**4. Classify by root cause, not symptom.** "Date handling" is a symptom;
"the system prompt never states the user's timezone" is a cause you can fix.
Causes are often not technical: missing user education, an unclear error
message, an auth state the agent can't see.

**5. Fix the top of the list. Then write the eval that keeps it fixed.**

The payoff is concentration: failure modes are rarely uniform. One real-estate
assistant found three categories accounting for 60% of failures, and fixing
date handling alone moved success from 33% to 95%.

### How much to read

Start by reading everything — all synthetic cases and a real sample. Stop when
the next trace stops teaching you anything, then keep a standing sample
forever. Model upgrades and changing user behaviour rot a taxonomy silently.

## The annotation viewer

The single highest-ROI piece of infrastructure, and usually about a day's work.
Its job is to remove every excuse not to look at data.

What it needs:

- **Everything on one screen.** The input, the output, the tool calls with
  arguments and results, and the domain state the agent was looking at. If
  judging a trace means opening the CRM in another tab, you will stop judging
  traces.
- **One-click binary verdict** plus a free-text note field. Forms with eight
  fields do not get filled in.
- **Filter and sort** by failure mode, feature, scenario, and source
  (synthetic vs real user).
- **Keyboard navigation.** You are going to do this a few hundred times.
- **Links out** to whatever lets someone verify the answer.

Build it in whatever you already know — a small React or FastHTML page, or a
spreadsheet to begin with.

The "build, don't buy" version of this advice has softened. Observability
platforms now ship annotation queues, trace clustering, and judge tooling that
work well enough to skip the first build. What they still cannot do is render
your domain: the CRM record, the contract terms, the booking calendar the
agent was looking at. So buy the plumbing if you want, but expect to build the
thin domain-specific view on top, and don't buy anything before you know what
you need to look at.

## Building the dataset

**Source from reality.** Bug reports, support escalations, the manual
pre-release checklist, production traces that went wrong. Cases invented to
exercise a feature test the feature as you imagined it, not as users hit it.

**Bootstrap synthetically before launch — structurally.** Enumerate three
dimensions and generate across their combinations:

- **Features** — what the agent is supposed to do (schedule a meeting, find a
  listing, issue a refund).
- **Scenarios** — the situations it must handle (exactly one match, many
  matches, no matches, ambiguous request, invalid data, tool error, incomplete
  information, an unsupported request).
- **Personas** — who is asking (new user, power user, non-native speaker,
  someone in a hurry, someone being vague).

Rules that make synthetic data useful rather than decorative: generate *user
inputs*, not expected outputs — run the inputs through the real system to get
outputs. Ground inputs in real constraints (actual IDs, valid date ranges,
real business rules). And verify each case actually triggers its scenario — a
"no matches" case that returns three matches is testing something else.

**Twenty to fifty is a working suite.** Effect sizes are large early: the
change either obviously helps or obviously doesn't. Grow the suite when you can
no longer distinguish two candidate changes, not on a schedule. For validating
a judge specifically, aim higher — roughly 100 examples per failure mode, with
a balanced pass/fail split.

**Spread the difficulty.** All-hard tells you nothing about regressions;
all-easy saturates. Keep a few cases nobody passes yet as the leading edge.

**Balance positive and negative.** For every case where the agent should act,
one where restraint is correct. Optimising against a one-sided set produces a
one-sided agent, and it ships as over-eagerness.

**Hold out a test split.** You will tune prompts against what you can see.
Keep 30–40% unseen and check there before believing an improvement. This
matters most for prompt and tool-description tuning, where overfitting is fast
and invisible.

## Eval awareness

This section has no counterpart in the 2024-era eval literature, because the
problem arrived with the model generation after it.

Current frontier models can distinguish an evaluation from ordinary use with
high reliability, and reasoning models sometimes say so in their traces
unprompted. The consequences for anyone building an eval suite are practical
rather than theoretical: if a case is recognisably a test, you may be
measuring the agent's best-behaviour mode instead of the behaviour your users
get. Safety and compliance cases are the most affected, because they are the
easiest to recognise and the ones where models have the clearest reason to
perform.

Verbalised awareness is a lower bound on real awareness — non-reasoning models
verbalise it under 1% of the time without obviously behaving as though
unaware — so absence of evidence in the trace means little.

What to do about it:

- **Prefer real production traces** as case inputs. They are unimprovable on
  this axis by construction.
- **Strip the tells** from synthetic cases: placeholder names, round numbers,
  implausibly tidy state, prompts that mention testing or evaluation,
  scenarios with exactly one obvious right answer.
- **Keep the register right.** Real users write untidily. A suite of
  well-formed grammatical requests is a different distribution from your
  traffic and looks like a test set.
- **Treat a production/eval gap as evidence about the suite.** When the agent
  passes comfortably and users still complain, the default explanation is that
  the suite isn't measuring the real distribution — awareness is one reason
  among several, but it belongs on the list now.

None of this is a reason to distrust evals generally. It is a reason to keep
real traffic in the loop rather than letting a synthetic suite become the only
thing you look at.

## Specifying a task

A task needs three things written down: the input, the success criteria, and a
reference solution.

**Success criteria two experts would score identically.** If you can't write
them without "appropriate", "good", or "reasonable", the task isn't ready.
Name what makes it appropriate, or pick a different task.

**A reference solution** proves the task is solvable and gives model graders
something to compare against. Produce it by hand, not by running the agent.

**Beware the impossible task.** A capable model scoring 0% across many trials
usually means the task is broken: contradictory instructions, an unreachable
resource, a grader that rejects the correct answer. METR found tasks telling
agents to *reach* a score threshold while the grader required *exceeding* it —
models were penalised for following instructions exactly.

**Beware the stochastic task.** If the environment changes between runs — live
data, a real clock, a shared queue — the task isn't reproducible and its score
is noise. Pin it, or demote it to a monitoring signal rather than a gate.

## Grader design

### Work down the ladder

Code graders first: exact and fuzzy match, regex, schema validation, running a
test suite, checking database or filesystem state, verifying a tool was or
wasn't called. Fast, free, reproducible, no calibration.

Model graders where the answer is open-ended: rubric criteria, factual
consistency against a reference, pairwise comparison.

Human graders as the calibration target for everything else, and for genuinely
subjective work.

Most teams reach for a model grader too early. Before writing a rubric, ask
what exactly makes an answer wrong — the honest answer is often a checkable
fact. Where a failure mode is deterministic, a code assertion beats a judge
permanently: it's cheaper, it can't drift, and it never needs re-aligning.

### Grade the outcome

Path checking is the most common grader bug. Agents take different routes on
identical inputs and sometimes find better ones than you did. A grader
requiring a specific sequence will fail correct behaviour and punish exactly
the models that generalise best.

Contract checks are not path checks. "Must consult the live pricing tool before
quoting" and "must not write to production during a read-only task" must hold
regardless of route. Assert those.

### Binary criteria, written critiques, summed for partial credit

Every judgment is pass/fail on one named criterion. Not 1–5. Nobody can defend
the line between a 3 and a 4, boundary cases consume the review budget, and an
average of vague scores is not actionable.

Partial credit comes from having several binary criteria, not from one fuzzy
scale. An agent that diagnosed the problem and botched the refund passes one
criterion and fails another: a reproducible 0.5. Keep a hard gate on anything
that must always hold.

**The critique matters more than the verdict.** A sentence explaining why,
written alongside every label, does three jobs: it forces the grader to
externalise what they actually meant, it becomes the few-shot example that
makes an LLM judge work, and it's the artifact that onboards the next person.
Write critiques on passes too, noting anything that was nearly wrong — "it
cancelled the flight as asked, but should have confirmed first; passes because
the core request was fulfilled" is a more useful record than "pass".

**Criteria drift is expected.** Your standards sharpen *while* you grade —
that's what grading is for. Treat the rubric as a living document, and re-label
earlier examples when it moves rather than pretending the old labels still
mean the same thing.

### Grader bugs that look like model failures

- **Over-precise matching.** Rejecting `96.12` against `96.124991…`. Opus 4.5
  went from 42% to 95% on CORE-Bench once grading issues like this were fixed.
- **Format sensitivity.** Failing a correct answer wrapped in different
  markdown, or preceded by a preamble.
- **Missing valid alternatives.** One accepted phrasing where three are right.
- **Threshold off-by-one** between the task statement and the grader.

The tell is a failure you would have scored as a pass. Read some.

## Building an LLM judge you can trust

A judge is a proxy for human judgment, so it needs its own evaluation. An
unvalidated judge produces confident numbers that mean nothing, and the team
acts on them.

The process below is Hamel Husain's *critique shadowing*. Its real output is
not the judge — it's that a domain expert was forced to look carefully at a
few hundred outputs and say exactly what "good" means.

**1. Find the principal domain expert.** One person, not a committee, whose
judgment is the ground truth: the clinician, the lawyer, the head of support.
Committees average away the standard. Do not stand in for them if you aren't
one — and note that this person tends to become the most invested stakeholder
in the product, which is a second benefit.

**2. Build a diverse dataset** across features × scenarios × personas, real or
synthetic (see above). Start around 30 examples and keep going until new
failure modes stop appearing.

**3. The expert labels pass/fail with a critique.** Binary only. Critiques
detailed enough that a new hire would understand the call, and specific enough
to paste into a prompt. Give them everything on one screen.

**4. Fix the obvious errors first.** If review surfaces a pervasive bug, fix it
and re-label before investing in a judge. There's no point automating the
measurement of something you already know is broken.

**5. Write the judge prompt iteratively.** You cannot write a good rubric
before seeing data — the act of grading is what defines the criteria.
Structure:

- the judge's role and the domain
- the criterion, stated as a binary question
- several few-shot examples, each with input, output, the expert's critique,
  and the pass/fail outcome
- an output format that puts the critique *before* the verdict, so the
  reasoning informs the call rather than rationalising it

Then align: give the expert a sheet of inputs, outputs, and the judge's
critique and verdict; have them fill in their own; compare; revise the prompt.
Two or three rounds to >90% agreement is typical.

**6. Measure TPR and TNR separately — never raw agreement.** If 5% of runs
fail, a judge that passes everything scores 95% agreement and catches nothing.
True positive rate (of the runs the expert failed, how many did the judge
fail) and true negative rate are the numbers that tell you whether it works.
Cohen's kappa is the standard single-number companion, because it corrects for
agreement you'd get by chance on a skewed set; report it alongside, not
instead of, the two rates.

Split the labeled data: ~10–20% as few-shot examples in the prompt, ~40% for
iterating, ~40% held out and untouched until the final check. A judge tuned
against all its data is as overfit as any other model.

**7. Then do error analysis with it.** Once aligned, the judge lets you compute
failure rates across every feature × scenario × persona cell cheaply, and find
the segments that are quietly bad.

### Biases to control

A judge is a model, and it brings model-shaped biases to grading. These are
well documented and they do not go away with capability: recent large-scale
work finds no judge uniformly reliable across benchmarks, with frontier models
still posting high error rates on adversarial bias tests, and consistency that
doesn't imply validity. Treat an uncontrolled judge as unsafe for ranking
decisions.

- **Position bias.** In any pairwise comparison, the judge favours one slot
  independent of quality. Rotate the order and average, or run both
  orderings and treat disagreement as a tie.
- **Self-preference bias.** A judge inflates scores for outputs from its own
  model family. Grade with a different family than the agent under test — this
  is stronger advice than "a different model".
- **Verbosity bias.** Longer answers score higher regardless of accuracy. This
  has genuinely weakened over the last couple of model generations, but check
  it rather than assuming: score a set of deliberately padded correct answers
  against terse correct ones.
- **Criterion leakage.** A judge given the reference answer will mark anything
  differently-worded as wrong. Give it the criteria, and the reference only
  where factual consistency is the criterion.

Chain-of-thought and few-shot examples measurably improve judge reliability,
which is why the prompt structure above puts critique before verdict and
carries real expert examples. Neither substitutes for the alignment loop.

### Other things worth knowing

- **Use the strongest model you can afford** for the judge. Critiquing well
  takes more capability than producing, and the judge runs offline where
  latency doesn't matter. Reasoning models are a good fit here for the same
  reason.
- **Account judge tokens separately** from application tokens, so grading cost
  stays visible and doesn't contaminate the agent's efficiency numbers.
- **Don't fine-tune the judge.** If you have labeled data to spare, fine-tune
  the primary model instead.
- **Re-align after material changes** — new model, new prompt architecture,
  shifted user population.
- **Resist metric sprawl.** An off-the-shelf framework offering eight generic
  dimensions is offering eight numbers nobody will act on. Measure your failure
  modes, not a vendor's list. There's nothing wrong with prebuilt judges as
  such — the harm is in mistaking their coverage for yours.
- **You can't remove humans entirely.** The judge aligns to *something*, and
  that something is human judgment. What scales down is how much labeling is
  needed, via sampling concentrated where alignment is weakest.

## The harness

**Isolation per trial.** Clean environment, fresh conversation, fresh fixtures,
nothing left over. Shared state produces correlated failures and fake passes —
Anthropic observed Claude gaining an unfair advantage by reading git history
left behind by earlier trials.

**Record everything.** Full transcript, tool calls with arguments and results,
final state, tokens, wall time, errors. You cannot debug a score, only a trace.

**Make reruns cheap.** Cache or replay what doesn't need to be live — external
APIs, retrieval, browser fetches — while keeping model calls live so the eval
stays sensitive to the thing you're changing. Review recorded fixtures in the
PR that changes them.

## Metrics

**pass@k** — succeeded at least once in *k* trials. Appropriate when a retry is
free and one success is a win.

**pass^k** — succeeded in every one of *k* trials. Appropriate when consistency
is the product. A 75% per-trial agent clears three trials 42% of the time
(0.75³), which is the number most people are unknowingly shipping against.

Always report *k*. A pass rate without a trial count can't be compared to
anything, including itself last week.

**Report cost next to correctness.** Tokens, tool calls, wall time, per case
and aggregate. A 5% quality gain for 3× the spend is a regression in most
products.

**Watch variance.** A case that flips between runs is either genuinely
marginal — interesting — or flaky infrastructure — noise to fix. Distinguish
them before averaging them away.

**Your target pass rate is a product decision.** Unlike unit tests, 100% isn't
the goal; decide which failures you can ship with and hold the line there.

## Agent-type notes

**Coding agents.** Deterministic grading works unusually well: run the tests.
Supplement with static analysis (lint, types, security), state checks, and a
model rubric for code quality — passing tests says nothing about whether the
diff is maintainable.

**Conversational agents.** The quality of the interaction is part of what
you're grading, not just the end state. Score task completion, turn efficiency,
and tone separately. Multi-turn cases usually need a second model simulating
the user; write that simulator's persona and stopping condition as carefully as
the agent's prompt, because a compliant simulator makes every agent look good.

**Research agents.** Quality is only judgeable relative to the task. Combine
groundedness (do the cited sources support the claims), coverage (facts that
must appear), and source quality. Exact match for objective questions, model
grading plus human calibration for synthesis.

**Computer-use and browser agents.** Grade the environment's final state — URL,
page state, filesystem, database, config. Track the efficiency tradeoff
explicitly: DOM interaction is fast but token-hungry, screenshots are
token-cheap but slow.

## Keeping the suite alive

**It has an owner.** An unowned suite decays into a slow CI job everyone skips.

**Domain experts contribute cases.** The people who know what "correct" means
are usually not the people maintaining the harness. Prompts are English —
give experts a way to edit prompts and add cases directly, in an admin view of
the real application, rather than routing their expertise through an engineer.
Make adding a case a five-minute job or it won't happen.

**Retire saturated suites.** At 100% a capability suite has stopped measuring.
Move its cases into the regression suite — where 100% is the point — and write
harder ones.

**Re-read traces periodically**, not just when something fails. Model upgrades
change behaviour in ways your graders were never written to notice.

Treat the suite the way you treat unit tests: routine maintenance, reviewed in
PRs, deleted when it stops earning its place.

## What has aged, and what hasn't

The workflow above is largely Hamel Husain's, written 2024–early 2025, checked
against newer work in September 2026. For anyone reading the originals
alongside this:

**Held up, and in several cases got empirical backing it didn't have then.**
Error analysis before tooling. Binary verdicts over 1–5 scales — later work
found Likert judges collapse toward the middle because nothing anchors a "3",
and that binary criteria summed into a score is the better way to get
granularity. Written critiques, and putting reasoning before the verdict.
Aligning the judge against one domain expert's labels. TPR and TNR over raw
agreement. Criteria drift.

**Sharpened.** "A different model from the agent" is now specifically "a
different model *family*", because self-preference bias follows lineage.
Position, verbosity, and length bias controls have gone from good practice to
table stakes, with the caveat that verbosity sensitivity has genuinely fallen.
Cohen's kappa joined the alignment metrics.

**Changed.** Error analysis at production scale is now model-assisted:
clustering thousands of traces by hand is not the job any more, validating the
clusters is. And "don't buy tools" has weakened — annotation and clustering
tooling got good, though the domain-specific view still has to be yours.

**New.** Eval awareness, above. Nothing in the 2024 literature anticipated
that the model might recognise the test.

Sources: [Hamel Husain — your AI product needs evals](https://hamel.dev/blog/posts/evals/),
[Hamel Husain — a field guide to rapidly improving AI products](https://hamel.dev/blog/posts/field-guide/),
[Hamel Husain — creating a LLM-as-a-judge that drives business results](https://hamel.dev/blog/posts/llm-judge/),
[Anthropic — demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents),
[Anthropic — how we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system),
[Reliability without validity: a large-scale evaluation of LLM-as-a-judge models](https://arxiv.org/pdf/2606.19544),
[A systematic study of position bias in LLM-as-a-judge](https://aclanthology.org/2025.ijcnlp-long.18.pdf),
[IAPS — evaluation awareness: why frontier AI models are getting harder to test](https://www.iaps.ai/research/evaluation-awareness-why-frontier-ai-models-are-getting-harder-to-test),
[OpenAI — agent evals](https://developers.openai.com/api/docs/guides/agent-evals)
