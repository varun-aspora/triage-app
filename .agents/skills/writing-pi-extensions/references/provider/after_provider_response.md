# after_provider_response

**Fires:** after an HTTP response is received, before its stream body is
consumed.
**Can change:** no. Inspection only.

## Signature

```typescript
pi.on("after_provider_response", (event, ctx) => {
  // event.status  - HTTP status code
  // event.headers - normalized response headers
  if (event.status === 429) {
    console.log("rate limited", event.headers["retry-after"]);
  }
});
```

Handlers run in extension load order.

## Where to use it

- **Rate-limit visibility** — read `retry-after` and remaining-quota headers and
  surface them in the footer instead of letting the user guess why pi stalled.
- **Cache-hit telemetry** — providers that report cache status in headers.
- **Request ID capture** — record the provider's request ID alongside the
  session so a failure can be chased with the vendor.
- **Detect gateway routing** — which upstream actually served the request.

## Gotchas

- **Header availability depends on provider and transport.** Providers that
  abstract HTTP away may expose nothing. Code defensively.
- This fires before the body is read, so you cannot see the response content
  here. Use `message_end` for that.
- A non-2xx status here doesn't mean the run failed — pi may retry.
