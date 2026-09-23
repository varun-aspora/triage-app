---
title: Flue SDK errors
source: https://flueframework.com/docs/sdk/errors/
bundled_docs: bunx flue docs read sdk/errors
version: "2.0.8"
reviewed: "2026-09-17"
---

# Flue SDK errors

## Purpose and when

Discriminate admission/API failures, admitted-work failures, stream transport failures, and local cancellation. Branch on classes and stable fields, never composed `message` strings.

## SDK error shapes

```ts
class FlueApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly ref: string | undefined;
  constructor(status: number, body: unknown, headerRef?: string);
}

type FlueExecutionTarget = 'agent_submission';
type FlueExecutionFailure = 'failed' | 'aborted' | 'terminal_event_missing';

class FlueExecutionError extends Error {
  readonly target: FlueExecutionTarget;
  readonly targetId: string;
  readonly failure: FlueExecutionFailure;
  readonly error: unknown;
  constructor(options: {
    target: FlueExecutionTarget;
    targetId: string;
    failure: FlueExecutionFailure;
    error?: unknown;
  });
}
```

`FlueApiError` means a JSON request (`send`, `abort`, `history`) received non-2xx. `body` is parsed JSON, raw text, or `''`; it remains `unknown` because middleware and gateways can answer. `ref` comes from `error.ref` or `flue-error-ref` and correlates production internal errors.

`FlueExecutionError` means work was admitted but `wait()`/`read()` observed failed, aborted, or no terminal event. `targetId` is the submission id. `error` is the serialized settlement failure when available.

## Server wire shapes

```ts
interface FlueHttpErrorBody {
  error: {
    type: string;
    message: string;
    details: string;
    dev?: string;
    meta?: Record<string, unknown>;
  };
}

interface SerializedExecutionError {
  name?: string;
  message: string;
  type?: string;
  details?: string;
  dev?: string;
  meta?: Record<string, unknown>;
}
```

Only `type` is stable machine identity. `message`/`details` are caller-safe prose; `dev` is optional local-development guidance. Notable send conditions:

- `404 agent_instance_not_found`: string `uid` named a missing or different incarnation; nothing delivered.
- `409 agent_instance_exists`: `uid: null` create-only send found an instance; existing uid is in `body.error.meta.uid`.

The full stable `type` catalog (every `error.type`/`FlueExecutionError.error.type` value the runtime can emit, and its HTTP status) is the bundled `reference/errors` page (`bunx flue docs read reference/errors`) — it is not yet mirrored as its own file in this skill's reference set, so read it directly when a `type` value needs confirming.

## Stream error shapes

Re-exported from `@durable-streams/client`:

```ts
class DurableStreamError extends Error {
  code:
    | 'NOT_FOUND' | 'CONFLICT_SEQ' | 'CONFLICT_EXISTS' | 'BAD_REQUEST'
    | 'BUSY' | 'SSE_NOT_SUPPORTED' | 'UNAUTHORIZED' | 'FORBIDDEN'
    | 'RATE_LIMITED' | 'ALREADY_CONSUMED' | 'ALREADY_CLOSED'
    | 'PARSE_ERROR' | 'STREAM_CLOSED' | 'UNKNOWN';
  status?: number;
  details?: unknown;
}

class StreamClosedError extends DurableStreamError {
  readonly code: 'STREAM_CLOSED';
  readonly status: 409;
  readonly streamClosed: true;
  readonly finalOffset?: string;
}

class FetchError extends Error {
  status: number;
  text?: string;
  json?: object;
  headers: Record<string, string>;
  url: string;
}

class FetchBackoffAbortError extends Error {}
```

Stream transport retries network errors, `429`, `503`, and all `5xx` with backoff, indefinitely by default; bound retries through per-call `backoffOptions`. Non-retryable 4xx typically surface as `FetchError`.

## How to

```ts
import {
  FlueApiError,
  FlueExecutionError,
  createFlueClient,
} from '@flue/sdk';

try {
  const admission = await client.send({ message });
  const reply = await client.read(admission);
} catch (error) {
  if (error instanceof FlueApiError) {
    reportRejectedRequest(error.status, error.body, error.ref);
  } else if (error instanceof FlueExecutionError) {
    reportSettlement(error.targetId, error.failure, error.error);
  } else if (error instanceof DOMException && error.name === 'AbortError') {
    reportLocalCancellation();
  } else {
    throw error;
  }
}
```

Validate `FlueApiError.body` before reading `error.type` or `meta`.

## Recommended patterns

- Check `instanceof` first, then branch on `status`, envelope `type`, execution `failure`, or stream `code`.
- Log `FlueApiError.ref` when present so operators can locate the exact server-side 500 record.
- Treat `FlueExecutionError.failure === 'aborted'` as durable server outcome, distinct from local cancellation.
- Bound stream retry backoff where callers have latency or availability deadlines.
- Persist admission identity so failures after local process loss can be recovered with `read()` rather than resending.

## Avoid

- Do not match error `message` strings.
- Do not assume `FlueApiError.body` is a Flue JSON envelope.
- Do not classify an aborted `AbortSignal` as failed agent execution.
- Do not blindly retry an ambiguous `send()`; the first request may already have been admitted.
- Do not wrap `observe()` in `try/catch` expecting asynchronous connection errors.

## Gotchas

- `wait()` does not make a JSON request, so it does not throw `FlueApiError`; it surfaces execution, stream, protocol, or cancellation errors.
- `observe()` never throws: `404` becomes `phase: 'absent'`; status `400`/`401`/`403` becomes `error`; other failures become retrying `connecting` state.
- Local SDK signals reject JSON calls as the fetch implementation chooses; standard fetch uses `DOMException` named `AbortError`.
- `wait()` rejects with `signal.reason`, or an `AbortError` if no reason was supplied.
- `FlueEventStream.cancel()` and loop break end iteration without throwing.
- Relative or invalid client URLs throw native synchronous `TypeError`, not an SDK error.

## Related

- [FlueClient](sdk_flue-client.md)
- [Events](sdk_events.md)
- [createFlueClient](sdk_create-flue-client.md)
- [Durability](advanced_durability.md)
