# before_provider_request

**Fires:** after the provider-specific payload is built, right before the
request is sent.
**Can change:** yes — can replace the whole payload.

## Signature

```typescript
pi.on("before_provider_request", (event, ctx) => {
  console.log(JSON.stringify(event.payload, null, 2));

  // optional: replace the payload
  // return { ...event.payload, temperature: 0 };
});
```

Handlers run in extension load order. Returning `undefined` keeps the payload.
Returning anything else replaces it for later handlers and for the request.

## Where to use it

- **Debugging provider serialization** — this is the primary use. Dump the exact
  JSON to see how messages, tools, and cache breakpoints were serialized.
- **Inspect cache behaviour** — check where `cache_control` markers landed.
- **Force a sampling parameter** the rest of pi doesn't expose for your provider.
- **Strip or rewrite provider-level system instructions** for a gateway with
  unusual requirements.

## Gotchas

- Payload-level changes are **not** reflected by `ctx.getSystemPrompt()`, which
  reports pi's system prompt string, not the serialized payload.
- You are editing raw provider JSON with no validation. A wrong shape fails the
  request at the provider with an opaque error.
- Logging the full payload logs the entire conversation, including file contents
  and secrets. Don't leave it enabled.
- Prefer `context` / `before_agent_start` for anything expressible there; they
  survive provider changes, this doesn't.
