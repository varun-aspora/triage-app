# before_provider_headers

**Fires:** after the outgoing HTTP headers are assembled, before the request is
sent.
**Can change:** yes — mutate `event.headers` in place.

## Signature

```typescript
pi.on("before_provider_headers", (event, ctx) => {
  // add or override
  event.headers["x-session-id"] = ctx.sessionManager.getSessionId();

  // delete a header pi adds
  event.headers["X-OpenRouter-Title"] = null;
});
```

Set a key to a string to add or override it; set it to `null` to delete it.
There is no return value — mutate in place.

## Where to use it

- **Gateway attribution and tracing** — send the session ID, user, team, or cost
  centre so an LLM proxy can attribute spend.
- **Auth for a corporate proxy** — attach a short-lived token your extension
  refreshes.
- **Strip tracking headers** pi adds that your gateway rejects or you'd rather
  not send.
- **Feature flags / beta headers** for a specific provider.

## Gotchas

- Runs **once per provider request**; retries reuse the same headers rather than
  re-firing the hook. Don't put per-attempt nonces here.
- Handler is synchronous in practice — fetching a token here blocks the request.
  Refresh tokens on a timer or in `session_start` and read the cached value.
- Header names are provider-dependent; check the actual key casing pi emits
  before trying to delete one.
