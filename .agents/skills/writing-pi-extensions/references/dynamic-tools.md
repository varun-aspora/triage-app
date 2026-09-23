# Dynamic tool loading

Register many tools but keep only a small set active, and let a loader tool
expand the active set on demand. This keeps the prompt small when the extra
tools aren't relevant, at the cost of an extra round trip when they are.

## How pi handles the transition

pi stores the initial prompt and tool loadout in the transcript's first system
message, then appends tool and prompt **deltas** before the next model request.
Providers that cannot represent a transition instead receive a complete
transcript checkpoint, which may invalidate the cached prefix.

That is the real trade-off: every change to the active tool set risks a cache
miss. Toggling tools on every turn to imitate search costs more than it saves.

## Lifecycle

1. Register **every** tool with `pi.registerTool()` so it appears in
   `pi.getAllTools()`.
2. Keep loader tools (e.g. `search_tools`) active; leave searchable tools
   inactive.
3. During loader execution, call `pi.setActiveTools()` with the names to
   activate. Names must already be registered — **unknown names are silently
   ignored**.

## Worked example

Two searchable tools plus a loader. The matching here is naive keyword scoring;
a real one could use BM25, embeddings, a remote catalog, or project-specific
routing.

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SEARCHABLE_TOOL_NAMES = new Set(["lookup_weather", "search_issues"]);

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "lookup_weather",
    label: "Lookup Weather",
    description: "Look up the current weather for a city",
    parameters: Type.Object({ city: Type.String() }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: `Weather for ${params.city}: sunny` }], details: {} };
    },
  });

  pi.registerTool({
    name: "search_issues",
    label: "Search Issues",
    description: "Search project issues by keyword",
    parameters: Type.Object({ query: Type.String() }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: `No open issues matching ${params.query}` }], details: {} };
    },
  });

  pi.registerTool({
    name: "search_tools",
    label: "Search Tools",
    description: "Search for and enable tools relevant to a task",
    promptSnippet: "Search for additional tools when the active tools cannot perform the task",
    promptGuidelines: [
      "Use search_tools when a task requires a capability that is not currently available.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Capability or task to search for" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    }),
    async execute(_id, params) {
      const terms = params.query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const matches = pi.getAllTools()
        .filter((tool) => SEARCHABLE_TOOL_NAMES.has(tool.name))
        .map((tool) => ({
          tool,
          score: terms.reduce(
            (score, term) =>
              score + (`${tool.name} ${tool.description}`.toLowerCase().includes(term) ? 1 : 0),
            0,
          ),
        }))
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, params.limit ?? 3)
        .map((match) => match.tool.name);

      if (matches.length === 0) {
        return { content: [{ type: "text", text: `No tools found for: ${params.query}` }], details: { matches: [] } };
      }

      const active = pi.getActiveTools();
      const added = matches.filter((name) => !active.includes(name));
      pi.setActiveTools([...new Set([...active, ...added])]);

      return {
        content: [{
          type: "text",
          text: added.length > 0
            ? `Loaded tools: ${added.join(", ")}`
            : `Matching tools already active: ${matches.join(", ")}`,
        }],
        details: { matches, added },
      };
    },
  });

  pi.on("session_start", () => {
    // Keep searchable tools registered but inactive. Preserve built-ins and
    // other extensions' tools, and keep the loader itself active.
    const initialTools = pi.getActiveTools().filter((name) => !SEARCHABLE_TOOL_NAMES.has(name));
    pi.setActiveTools([...new Set([...initialTools, "search_tools"])]);
  });
}
```

When `search_tools` adds a match, the model receives the complete updated tool
list on the immediately following request.

## When it's worth it

- **Large tool catalogs** — dozens of API operations where any one task needs
  three of them. The prompt savings outweigh the extra round trip.
- **Prerequisite gating** — `deploy_*` tools only become active after
  `run_tests` succeeded. Conditional visibility is a far stronger signal to the
  model than a prompt instruction saying "don't deploy before testing".
- **Mode switching** — plan mode narrows to read-only tools; a command restores
  the full set.
- **Per-model loadouts** — a smaller model gets fewer tools, driven from
  `model_select`.

## When not to

- Fewer than roughly a dozen tools. The cache churn and the extra round trip
  cost more than the prompt tokens you save.
- Tools needed on nearly every turn. Keep those permanently active.
- As a substitute for good descriptions. If the model picks the wrong tool, the
  fix is usually clearer names and descriptions, not hiding them.

## Gotchas

- **`setActiveTools()` replaces the whole set.** Always merge with
  `pi.getActiveTools()` or you disable built-ins and other extensions' tools:
  `pi.setActiveTools([...new Set([...pi.getActiveTools(), "my_tool"])])`.
- **Keep the loader active.** Deactivating `search_tools` along with everything
  else leaves the model with no way back. This is the classic self-lockout.
- Unknown names are ignored silently — a typo means nothing is activated and no
  error is raised.
- Conditional visibility is **not** authentication. Bind tenant, repo, and
  credentials in application code; the model must never supply them.
- Doing this from `before_agent_start` via `selectedTools` has the same effect
  as `setActiveTools()` and is a good place for deterministic, state-driven
  loadouts that don't need the model to ask.

## See also

[tools.md](tools.md) · [agent/before_agent_start.md](agent/before_agent_start.md) ·
[api.md](api.md)
