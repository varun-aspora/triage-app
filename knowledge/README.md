# knowledge/

The knowledge the agents get: always-on instruction text, on-demand skills and
the classifier's category list. This file is the layout contract. The loader
(`src/agents/skills.ts`), the instruction composer (`src/agents/instruction.ts`)
and the tests under `test/knowledge/` all follow it. When the contract changes,
change this file, `test/knowledge/_util.ts` and the loader together.

At runtime the tree is read from `TRIAGE_KNOWLEDGE_DIR`, resolved against
`TRIAGE_HOME` (default `./knowledge`). It is read once at boot and never
imported as a module (HLD §1.1, D42).

## Layout

```
knowledge/
  README.md                 this contract; the only file at the top level
  method/*.md               always-on instruction text, never a skill
  classifier/categories.json
  <entity>-overview/SKILL.md
  <entity>-<service>/SKILL.md
  patterns/SKILL.md + patterns.json
  repo-map/SKILL.md
  codegraph-limits/SKILL.md
  frontend-routing/SKILL.md
```

- Every top-level directory other than `method/` and `classifier/` is a skill
  directory and holds a `SKILL.md`. Flue names a skill after its directory, so
  the directory name is the skill name and must be unique across the tree.
- Skill directory names take one of these forms:
  - `<entity>-overview` for each entity: the ID chain, service ownership and
    join keys.
  - `<entity>-<service>` for a service note, where `<service>` is the service
    key in `resources/<entity>.entity.json` (for example `ssfb-harbor`,
    `atspl-package`, `rtl-workflow`).
  - one of the global names `patterns`, `repo-map`, `codegraph-limits`,
    `frontend-routing`.
- `<entity>` is `ssfb`, `atspl` or `rtl`. Names are lowercase letters, digits
  and single hyphens, at most 64 characters.
- A skill directory may hold supporting files next to `SKILL.md` (for example
  `patterns/patterns.json`). A `SKILL.md` never sits deeper than
  `knowledge/<name>/SKILL.md`, and never under `method/` or `classifier/`.
- `method/` holds flat `*.md` files only. `classifier/` holds data files for
  the classifier.

## Which agent gets what

| Agent | Instruction (`method/`, always on) | Skills (on demand) |
|---|---|---|
| `Triage` | `orchestrator.md`, `brief-template.md`, `report-format.md` | `<entity>-overview` for each enabled entity, `patterns`, `frontend-routing` |
| `investigate_<entity>` and `investigate_<entity>_deep` | `investigator.md`, `logs.md`, `logs-<entity>.md` | `<entity>-<service>` for the registry's services, `repo-map`; `codegraph-limits` on the deep variant only |
| `code_walker` | `code-walker.md` | `repo-map`, `codegraph-limits`, `frontend-routing` |

Instruction text is for what an agent always needs. Skills are for knowledge
it needs only on some runs. A method file names only tools and delegates the
agent that reads it has; `test/knowledge/_util.ts` lists them per agent.

## SKILL.md front-matter

Only this subset of the Agent Skills front-matter is used:

```
---
name: ssfb-harbor
description: What the note covers and when to use it, on one line.
metadata:
  kind: service
  entity: ssfb
  service: harbor
  sources: shivalik/harbor/AGENTS.md
  status: ported
---

The note, in markdown.
```

- `name` is required and equals the directory name.
- `description` is required, non-empty, on one line and at most 1024
  characters. It is the only text the model sees before it activates the
  skill, so it says what the note covers and when to use it.
- `metadata` is a flat map of strings, indented by two spaces. Its keys are:
  - `kind` (required): `overview`, `service`, or the global name itself
    (`patterns`, `repo-map`, `codegraph-limits`, `frontend-routing`).
  - `entity` (required): `ssfb`, `atspl` or `rtl` for an overview or a service
    note; `shared` for a global skill.
  - `service`: required for a service note and absent otherwise. It is the
    registry service key, and the name is `<entity>-<service>`.
  - `sources`: the files the note was ported from, comma separated.
  - `status`: `ported`, `written` (new text, no single source) or `stub`
    (a placeholder whose content is unverified).
- No other keys. No lists, nested maps, block scalars or comments.
- Values are plain text, or quoted with `"` or `'`. Quote a value that
  contains `: ` or ` #`, or that YAML would read as a boolean, number, null or
  date (such as `true`, `3` or a bare date). Every value must be a string.
- The body after the closing `---` must not be empty.

## Writing conventions

- **Unverified claims.** A claim the port could not confirm carries the
  marker `(unverified: <reason>)` right after it, for example
  `cohort owns these tables (unverified: no source documents them)`. Do not
  drop such a claim silently and do not state it as fact.
- **Placeholder ids.** Ids in examples, queries and recipes are always
  placeholders: lowercase snake case in angle brackets, such as
  `<customer_id>`, `<form_id>`, `<account_id>` or `<account_number>`. Never
  put a real id, name, phone number or account number in a note.
- **Tools, not scripts.** Queries and checks are written as tool calls
  (`sql_select`, `http_call`, `logs_search` and so on) with placeholder
  parameters. Notes never name wrapper scripts, local paths, CLI flags or
  environment variables.
- **No environment names.** One deployment has one configuration, so a note
  never names an environment, a host, a port, a URL or a connection string.
  The service and the tool are enough. The deploy manifests repo names that
  look like environment names are allowed by name in the lint, and only
  repo-map names them.
- **No customer data.** Nothing under `knowledge/` is copied from past case
  folders of the old workspace. Notes come from its `AGENTS.md` files and
  skills, and from the design docs.

## Classifier categories

`classifier/categories.json` is an array with one entry per `Classification`
category in `src/types/classification.ts`, `unknown` included, and no others.
Each entry has:

| Field | Meaning |
|---|---|
| `id` | The category id. |
| `label` | A short human name. |
| `description` | What the category covers. |
| `signals` | Phrases in a thread that point at the category. Non-empty. |
| `typical_entities` | A subset of `ssfb`, `atspl`, `rtl`. May be empty. |
| `typical_services` | Registry keys written `entity:service`. May be empty. |
| `subcategories` | snake_case subcategory ids. |
| `notes` | Difficulty and routing hints. |

The list carries no tier flags: tier policy is code in `src/classify/`.

## Checks

`bun run test` runs `test/knowledge/`:

- `frontmatter.test.ts`: the layout and front-matter rules above.
- `lint.test.ts`: content hygiene over every file under `knowledge/`. It
  rejects UUIDs, runs of six or more digits, emails, PAN-shaped strings, URLs,
  connection strings, hostnames and ports, bearer tokens, JWTs, Slack ids and
  handles, environment names, and the names of the old workspace's scripts,
  config paths and tools. The full list is `LINT_RULES` in
  `test/knowledge/_util.ts`.
- `categories.test.ts`: the category list against `src/types/classification.ts`
  and the registry.
