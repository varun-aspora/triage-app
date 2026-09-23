# resources_discover

**Fires:** after `session_start`, on startup and on `/reload`.
**Can change:** yes — adds resource search paths.

## Signature

```typescript
pi.on("resources_discover", async (event, _ctx) => {
  return {
    skillPaths: ["/path/to/skills"],
    promptPaths: ["/path/to/prompts"],
    themePaths: ["/path/to/themes"],
  };
});
```

## Event

| Field | Type | Meaning |
|---|---|---|
| `cwd` | `string` | Current working directory |
| `reason` | `"startup" \| "reload"` | Why discovery is running |

## Return value

`{ skillPaths?, promptPaths?, themePaths? }` — each an array of directories.
Return nothing to contribute none.

## Where to use it

- **Monorepo skills** — point pi at `packages/*/skills` so each package ships its
  own skills without symlinks.
- **Shared team resources** — mount a cloned internal repo of prompt templates.
- **Computed paths** — resolve a skills directory from an env var, a config file,
  or the detected project type.

## Gotchas

- This only adds search paths. It does not load or validate their contents.
- Use `reason` to skip expensive discovery on `/reload` if the paths cannot have
  changed.
- Returning a path that doesn't exist is harmless but silent; log if you care.
