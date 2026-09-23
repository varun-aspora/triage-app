---
title: Flue Changelog and 2.0.8 Notes
source: https://github.com/withastro/flue/blob/main/CHANGELOG.md
bundled_docs:
  path: null
  version: null
package_version: 2.0.8
reviewed: 2026-09-17
---

# Flue Changelog and 2.0.8 Notes

## What this is and when to use it

Use this reference before upgrading Flue, when a behavior differs between
machines, or when generated code and online examples disagree. It summarizes
changes relevant to the `@flue/cli@2.0.8` installed in this project and explains
how to research package-specific releases. It is not a copy of the full
changelog.

On the review date, the repository's monolithic `CHANGELOG.md` ends at `2.0.6`,
while npm and package-specific GitHub releases contain `2.0.7` and `2.0.8`.
Therefore use both sources: the monolithic changelog for release context and
the exact package release page for newer package changes.

## Current 2.0.8 changes

The project resolves the lockstep CLI, runtime, and Vite packages to 2.0.8.
The runtime release focuses on correctness and Cloudflare behavior:

- Recovery renders that keep throwing now settle as timed out after the
  durability deadline instead of retrying forever.
- The Cloudflare Anthropic gateway maps `thinkingLevel` to adaptive-thinking
  effort.
- The Cloudflare binding provider accepts `cacheRetention: 'short' | 'long'`
  for Anthropic prompt caching; the default remains no cache retention.
- The first streamed delta after a quiet period flushes immediately rather
  than waiting for the coalescing interval.
- A failed partial model stream followed by a successful retry no longer
  exposes both the incomplete and replacement responses to clients.
- `isDynamicModel()` identifies models synthesized from dynamic templates, and
  the runtime warns when their cost is unknown rather than silently implying
  zero cost.
- GenAI trace fallbacks preserve the telemetry message schema when content is
  oversized, unserializable, or rejected by a transform.
- CLI and SDK documentation now direct Cloudflare sandbox setup through
  `flue add sandbox cloudflare` and explain the blueprint's changes.

Package release notes:

- Runtime: https://github.com/withastro/flue/releases/tag/%40flue%2Fruntime%402.0.8
- CLI: https://github.com/withastro/flue/releases/tag/%40flue%2Fcli%402.0.8
- SDK: https://github.com/withastro/flue/releases/tag/%40flue%2Fsdk%402.0.8

## Important 2.0.7 and 2.0.6 context

### 2.0.7

- Published packages again include bundled documentation, making
  `flue docs read ...` usable from the installation.
- Runtime fixes cover Cloudflare directory listings, trace correlation,
  Workers AI tool-only turns, harness-tool recursion, aborted/truncated tool
  batches, post-compaction continuation, terminating-tool compaction, and
  several Cloudflare Anthropic compatibility issues.
- SDK `observe()` resets reconnect backoff after a healthy stream lifetime.

### 2.0.6

- The monolithic changelog records the restoration of generated `docs/`
  directories after 2.0.4 and 2.0.5 omitted them.
- 2.0.5 republished invalid raw workspace dependency specifiers as real
  versioned dependencies.
- 2.0.4 made a bare `Connection error.` retryable.

The repeated bundled-docs note in 2.0.6 and package 2.0.7 release notes is a
publishing-history detail, not a reason to avoid current 2.0.8. Verify the
installed command directly.

## Idempotent delivery in current 2.0.x

Caller-keyed delivery is present in the installed 2.0.8 runtime even though
some bundled API prose omits the field. It applies to server-side dispatch,
the direct HTTP route, and the SDK:

```ts
const receipt = await dispatch(Support, {
  id: ticketId,
  message: {
    kind: 'signal',
    type: 'slack.message',
    body: event.text,
  },
  idempotencyKey: event.event_id,
});
```

```json
{
  "kind": "user",
  "body": "Retry-safe message",
  "idempotencyKey": "browser-request-01"
}
```

Exact contract in 2.0.8:

- `idempotencyKey` is a non-empty caller-chosen string of at most 256
  characters, scoped to the `(agent, instance ID)` target.
- Replaying the same key and payload returns the original `submissionId`,
  `acceptedAt`, and receipt with `deduplicated: true`; it does not admit a
  second turn.
- Reusing the key with a different payload rejects with HTTP `409` and
  `submission_conflict`.
- The key names the delivery, not a desired successful outcome. A failed
  submission remains failed; use a fresh key to request new work.
- It prevents duplicate admissions caused by redelivery. Runtime processing
  remains at-least-once, so external side effects still need idempotent design.

## Major 2.0 baseline

The 2.0.0 release introduced the architecture assumed by all current guides:

- Vite replaces `flue dev` and `flue build`.
- Explicit Hono routes in `app.ts` replace file-based auto-routing.
- Exported synchronous functions and hooks replace `defineAgent`.
- Workflows are removed in favor of agent handles, durable tools, or external
  orchestration.
- Sandboxes are opt-in.
- SDK clients address one conversation URL.
- Direct HTTP and dispatch use `DeliveredMessage`; sends are asynchronous.
- `submissionId` replaces `dispatchId`.
- Pre-1.0 persisted stores are reset-only.

Read the migration guide before upgrading a beta application; the changelog is
not a migration procedure.

## How to: research and apply an upgrade

1. Confirm the executable and resolved dependency, not just the semver range:

   ```bash
   bunx flue --version
   bun pm view @flue/cli@2.0.8
   ```

2. Inspect `bun.lock` to verify that `@flue/cli`, `@flue/runtime`, and
   `@flue/vite` resolve in lockstep.
3. Read the monolithic changelog from the current version back to the installed
   version.
4. If that file has not caught up, open the GitHub release for each package and
   exact version. Dependency-only release entries mean the package inherits
   changes from another Flue package.
5. Prefer installed docs for API shape:

   ```bash
   bunx flue docs search idempotency
   bunx flue docs read guide/channels
   ```

6. Cross-check public TypeScript declarations when bundled prose and release
   notes disagree.
7. Upgrade all related `@flue/*` packages together, then run typechecks, tests,
   a production Vite build, and an interruption/retry smoke test.

## Recommended patterns

- Pin or lock Flue packages together for reproducible behavior.
- Read package-specific releases for versions newer than the monolithic file.
- Convert a release note into a targeted regression test when it describes a
  failure mode your application can encounter.
- Use stable provider event IDs as delivery idempotency keys.
- Re-read installed docs after every CLI upgrade because `flue docs` is
  version-coupled to the package.

## Avoid

- Do not infer 2.0.8 behavior only from the top entry in `CHANGELOG.md`.
- Do not copy the entire changelog into project guidance; link to it and keep
  only operationally relevant changes.
- Do not treat a caret range in `package.json` as the resolved version.
- Do not use idempotency keys as conversation IDs or assume they make external
  side effects exactly-once.
- Do not retry a failed keyed submission with the same key when new work is
  intended.

## Gotchas

- Git tags named `v2.0.x` and package tags named `@flue/runtime@2.0.x` can have
  different release-note coverage. Match the package actually imported.
- Documentation was absent from some 2.0.4/2.0.5 artifacts and restored in
  later releases. A failed `flue docs` on those versions is a packaging issue.
- Release notes can describe runtime behavior inherited by CLI, Vite, database,
  or channel packages through lockstep dependencies.
- Dynamic-model cost warnings mean unknown cost, not a free model.

## Related references

- [Migration guide](introduction_migration.md)
- [Getting started](introduction_getting-started.md)
- [Building agents](guides_building-agents.md)
- [Repository changelog](https://github.com/withastro/flue/blob/main/CHANGELOG.md)
- [All GitHub releases](https://github.com/withastro/flue/releases)
- [`flue docs`](https://flueframework.com/docs/cli/docs/)
