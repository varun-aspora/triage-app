---
name: writing-evals
description: "Write, review, or fix evals for LLM agents — the automated tests that run an agent against a live model and assert on what it does, and the error analysis that tells you what to test. Use whenever the work touches an eval suite, a grader, an LLM judge, a `.eval.ts` file, `describeEval` / `vitest-evals`, `flue add tooling vitest-evals`, or questions like 'how do I test this agent', 'did that prompt change actually help', 'why is my eval flaky', 'how many cases do I need', 'is my judge any good', or 'the eval passes but the agent is still wrong'. Covers Flue's in-process and HTTP eval surfaces plus framework-neutral practice: error analysis, case design, graders, judge alignment, trials, cost, and CI."
---

# Writing evals

An eval runs an agent against a live model and asserts on observable
behaviour: the reply it produces, the tools it calls, the data it emits.

Everything you wrote by hand — a tool's `run` function, a formatter, a router —
is ordinary code with ordinary unit tests, and it should have them. The eval
covers the part unit tests cannot reach: the model's contribution. Does it call
the right tool, follow its instructions, and get the answer right.

Two properties drive every design decision that follows:

- **Nondeterministic.** The same input produces different wording, a different
  tool order, occasionally a different outcome. Assert on the behavioural
  contract, not on the transcript you happened to get.
- **Expensive.** Every case is one or more live model turns, in tokens and in
  seconds. Evals get their own suite, config, credentials, and run cadence.

Two references. Read [references/practices.md](references/practices.md) for
error analysis, case design, graders, judge alignment, and the failure modes —
it is framework-neutral. Read [references/flue.md](references/flue.md) when the
target is Flue: the two eval surfaces, the `vitest-evals` harness, and the
gotchas that only show up there.

## Look at the data before you write anything

The instinct is to start with a framework and a metrics dashboard. That
produces numbers that move without the product getting better. The first move
is error analysis: read actual transcripts and find out how this agent
actually fails, which is reliably not how you assumed it fails.

The loop:

1. **Read traces and write free-form notes.** One sentence per trace on what
   went wrong. No categories yet — categories you bring with you ("hallucination",
   "toxicity") are the ones you will find, and they are usually not your
   problem.
2. **Cluster the notes into a taxonomy.** Hand the notes to a model and ask for
   the recurring failure modes. This is where "the agent mishandles relative
   dates" emerges as a thing, rather than staying twelve separate annoyances.
   Above a few thousand traces, let the model do the clustering and the
   first-pass tagging — but confirm the cluster labels yourself, and have a
   second person check a sample. Automated tags you never validated are how a
   taxonomy quietly stops describing reality.
3. **Count them.** Frequency per failure mode, ideally split by feature,
   scenario, and user type so you can see which segment is bleeding. Rank by
   frequency × impact, not frequency alone.
4. **Fix the top of the list, then write the eval that keeps it fixed.**

This is not preamble to the real work. It is most of the value. One real-estate
assistant found three categories covering 60% of failures; fixing date handling
alone took its success rate from 33% to 95%. No dashboard would have said that.

Keep reading until you stop learning something new from the next trace. Then
keep a sample going forever — model upgrades change failure modes, and your
taxonomy goes stale quietly.

### Make looking at data frictionless

Whatever makes you hunt across three systems to understand one trace is the
reason you will stop doing this. Build the viewer — a small custom page beats
any generic tool because it can show *your* domain's context:

- everything needed to judge one trace on one screen, including the state the
  agent was looking at
- one-click pass/fail, plus a free-text note field
- filter and sort by failure mode, feature, source (synthetic vs real)
- keyboard navigation, because you are going to do this a few hundred times

This is usually a day of work and it is the highest-leverage day in the
project. Spreadsheets are a legitimate starting point. Off-the-shelf platforms
now do annotation queues and trace clustering competently, so buying is more
defensible than it was — but buy after you know what you need to look at, and
expect to still build something small that renders *your* domain's context,
which no general tool can.

## Start with twenty cases, from real failures

Twenty to fifty cases drawn from the taxonomy is a working suite. Early
changes move success rates enough (~30% → ~80% is typical on a new agent) that
a small sample sees them clearly. Grow the suite when you can no longer tell
two candidate changes apart, not on a schedule.

Mine what exists: bug reports, the manual checks someone runs before shipping,
the thread where the agent embarrassed someone. Prioritise by user impact.

**Before launch, bootstrap synthetically — but structurally.** Enumerate the
dimensions (features × scenarios × personas), generate *inputs* across the
combinations, and run them through the real system to get outputs. Ground the
inputs in real constraints — actual IDs, valid date ranges, real business
rules — and verify each case triggers the scenario it claims to (a "no
results" case that returns results is testing nothing).

**Your pass rate is a product decision.** Unlike unit tests, 100% is not the
target. Decide which failures you're willing to ship with.

## What makes a case worth having

**Two people should independently agree on the verdict.** If reasonable
reviewers disagree, the case is underspecified and its score is noise.

**Write the reference solution.** Solve it yourself and record the answer. This
proves the case is solvable and gives graders something to compare against. A
frontier model scoring 0% across many trials is nearly always a broken case —
check the task before you tune the agent.

**Balance positive and negative.** For every case where the agent should act,
have one where the correct behaviour is restraint: answer from knowledge
instead of searching, ask instead of guessing, refuse. One-sided evals produce
one-sided agents, and it shows up in production as over-eagerness.

**Isolate each trial.** Fresh conversation, fresh working directory, fresh
fixtures. Shared state produces correlated failures and, worse, fake passes —
Anthropic found Claude reading git history left behind by earlier trials and
scoring above its real ability.

**Make cases look like real traffic.** This is newer advice than the rest of
this page. Current frontier models can reliably tell an evaluation from
ordinary use, and some reason about it explicitly — which means a case with
obvious test scaffolding (placeholder names, a suspiciously tidy setup, a
prompt that announces it is a test) may be measuring the agent's
best-behaviour mode rather than the one your users get. Prefer real production
traces, keep synthetic inputs in the register your users actually write in,
and treat "passes the suite but disappoints in production" as a signal about
the suite, not only the agent.

## Assert on the outcome, not the path

There is a strong instinct to check that the agent took the steps you had in
mind. It is usually wrong. Identical runs take different routes, and agents
find valid solutions you did not anticipate — one model solved a τ²-bench
booking task through a legitimate policy loophole and "failed" a grader that
only recognised the intended route.

Grade the end state. Where a long workflow needs intermediate checks, pick a
few discrete checkpoints rather than every step, and make them things that
*must* be true rather than things you expect to see.

Path assertions do earn their place in two cases: a tool that **must** be
called before answering (a live lookup, a permission check), and a tool that
must **never** be called (a write during a read-only task). Those are contract,
not path.

## Pick the cheapest grader that works

| Grader | Good at | Costs |
| --- | --- | --- |
| **Code** — exact/fuzzy match, schema validation, state check, tool-call check | Fast, free, reproducible, no calibration | Brittle to valid variation; can't judge nuance |
| **Model** — per-criterion verdicts against a written rubric | Handles open-ended output and tone | Nondeterministic, costs tokens, needs alignment work |
| **Human** | The ground truth everything else is calibrated against | Slow, expensive, doesn't scale |

Work down the list, not up. Most of what people reach for a judge to do is
checkable in code: did it call `create_refund`, is the output valid against the
schema, does the row exist, is the amount 4200. Conquer the code-checkable
failures first — they're cheaper to write and they never drift.

### Binary verdicts, plus a written critique

Every judgment — human or model — is pass/fail on one named criterion, with a
sentence saying why. Not 1–5. Nobody can tell you the difference between a 3
and a 4, the boundary cases eat all the review time, and the resulting average
is not actionable.

This does not cost you partial credit. Partial credit comes from *several*
binary criteria, scored and summed: an agent that diagnosed the problem but
botched the refund passes one and fails the other. That is a real 0.5, unlike a
3-out-of-5 that nobody can reproduce. Keep a hard gate on anything that must
always hold.

The written critique does more work than the verdict. It forces whoever is
grading to externalise what they actually meant, it becomes the few-shot
example that makes an LLM judge work, and it's the artifact you hand someone
new. Write critiques on passes too, when something was nearly wrong.

Expect your criteria to change *while* you grade — clarifying the standard is
what grading is for. That's criteria drift and it's normal. Treat the rubric as
a living document and re-label the earlier examples when it moves.

### An LLM judge is a proxy, so it needs its own eval

A judge you have not validated is a random number generator with a rationale
attached. The short version:

- One domain expert is the ground truth. Not a committee, not you standing in
  for them.
- They label examples pass/fail with critiques. Their critiques go into the
  judge prompt as few-shot examples.
- Have the judge write its reasoning *before* its verdict. This is the single
  cheapest accuracy win available, and it gives you something to read when the
  judge is wrong.
- Compare judge to expert, fix the prompt, repeat. Two or three rounds to
  >90% agreement is typical.
- **Measure true positive rate and true negative rate separately**, plus
  Cohen's kappa. Raw agreement lies: if 5% of runs fail, a judge that passes
  everything scores 95% agreement while catching nothing.
- Hold out a test split the judge prompt was never tuned against.
- Run the judge on a different model *family* from the agent — self-preference
  bias is real and inflates scores for a model grading its own lineage — on the
  strongest model you can afford, and account its tokens separately.
- Control the known biases. Rotate option order in any pairwise comparison
  (position bias), and watch for length preference. No judge is uniformly
  reliable — recent large-scale work finds frontier models still posting high
  error rates on adversarial bias tests — so an uncontrolled judge is not safe
  for ranking decisions.

Full process in [references/practices.md](references/practices.md). Resist
metric sprawl — the eight generic dimensions an off-the-shelf framework offers
you ("helpfulness", "toxicity") are not your failure modes, and measuring them
is how teams end up with dashboards nobody acts on.

## Nondeterminism means running it more than once

A single run tells you almost nothing. Run each case *k* times and decide which
number you care about:

- **pass@k** — succeeded at least once in *k* tries. Use it when a retry is
  acceptable and one success is a win.
- **pass^k** — succeeded every time in *k* tries. Use it when consistency is
  the product. A 75% per-trial agent passes three consecutive trials 42% of the
  time.

Most production agents are judged on pass^k whether anyone says so or not. Pick
deliberately, and record *k* next to the score — a pass rate without a trial
count is not comparable to anything.

## Two suites, two jobs

**Capability evals** ask what the agent can do. They should start with a low
pass rate — a suite that passes on day one had nothing to teach you. You
hill-climb on these.

**Regression evals** sit at ~100% and stay there. They catch what the last
prompt change quietly broke. Run them on every change; treat a failure as a
bug, not a score.

Watch for **saturation**. A capability suite at 100% has stopped measuring and
needs harder cases. SWE-bench Verified went from ~30% to 80%+ in a couple of
years; internal suites saturate faster.

## Record cost, not just correctness

Every case carries tokens, tool-call count, and wall time alongside its
verdict. An agent that got 5% better by spending 3× the tokens and twice the
latency is a regression in most products, and a pass rate hides that. It also
catches the "fixed it by making the agent try everything" non-solution.

## In Flue

Flue has no eval framework of its own. An eval is a Vitest test that drives the
agent through a public surface and asserts on the result. There are two
surfaces and the choice matters:

| | In-process — `start()` + `init()` | HTTP — `@flue/sdk` |
| --- | --- | --- |
| Exercises | Agent, hooks, tools, model | All of that plus `app.ts` routing and middleware |
| Needs | Provider credentials in the test process | A running dev server or a deployment |
| Gives you | `reply.text`, `reply.data`, tool calls via `onEvent` | Text and tool parts from `history()` |
| Breaks on | Build-resolved imports (a `SKILL.md` import) | Nothing the app itself doesn't break on |

`flue add tooling vitest-evals` layers harnesses, judges, normalised reports,
and CI reporting on top of the HTTP surface. It is the right default for a
project that will keep evals around, and `vitest-evals serve` is a serviceable
first trace viewer.

[references/flue.md](references/flue.md) has working code for both surfaces,
what the generated harness does, and the gotchas — usage metadata that silently
doesn't exist, subagent tool calls that never reach the transcript, and the dev
server the eval run will not start for you.

## Checklist

- [ ] Someone has read raw traces and written a failure taxonomy with counts
- [ ] Cases come from that taxonomy, not from imagination
- [ ] Looking at a trace takes one screen and one click
- [ ] Two reviewers would agree on every verdict
- [ ] Each case has a reference solution that proves it's solvable
- [ ] The set includes cases where the right answer is to not act
- [ ] Every trial starts from clean state
- [ ] Graders check the end state; path checks are contract, not habit
- [ ] Code graders used wherever the check is exact
- [ ] Cases read like real traffic, not like tests
- [ ] Verdicts are binary per criterion with a written critique, not 1–5
- [ ] Any LLM judge is aligned against expert labels, scored on TPR and TNR
      separately, on a held-out split, and runs on a different model family
      with position and length bias controlled
- [ ] Trial count *k* is chosen and recorded, with pass@k or pass^k named
- [ ] Capability and regression suites are separate, on different cadences
- [ ] Tokens, tool calls, and latency recorded per case
- [ ] Evals are a separate CI job from unit tests, with their own credentials
- [ ] The suite has an owner

Sources: [Hamel Husain — your AI product needs evals](https://hamel.dev/blog/posts/evals/),
[Hamel Husain — a field guide to rapidly improving AI products](https://hamel.dev/blog/posts/field-guide/),
[Hamel Husain — creating a LLM-as-a-judge that drives business results](https://hamel.dev/blog/posts/llm-judge/),
[Anthropic — demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents),
[Anthropic — how we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system),
[Reliability without validity: a large-scale evaluation of LLM-as-a-judge models](https://arxiv.org/pdf/2606.19544),
[IAPS — evaluation awareness: why frontier AI models are getting harder to test](https://www.iaps.ai/research/evaluation-awareness-why-frontier-ai-models-are-getting-harder-to-test),
[Flue — evals](https://flueframework.com/docs/guide/evals/),
[vitest-evals](https://vitest-evals.sentry.dev/docs/)
