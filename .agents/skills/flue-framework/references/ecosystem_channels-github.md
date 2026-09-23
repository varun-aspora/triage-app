---
title: GitHub channel
source: https://flueframework.com/docs/ecosystem/channels/github/
bundled_docs: ecosystem/channels/github
version: 2.0.8
reviewed: 2026-09-17
---

# GitHub channel

## When to use

Use the GitHub channel for agents driven by signed GitHub webhooks, such as
issue comments, pull-request review comments, issues, or other native GitHub
event families. Outbound GitHub behavior uses an application-owned Octokit
client rather than a Flue messaging abstraction.

A typical design keeps one agent instance per repository issue or pull request,
filters deliveries by event and action, and binds an issue-comment tool to that
verified destination.

## Prerequisites and environment variables

- A repository, organization, or GitHub App webhook with a public HTTPS URL.
- A webhook secret configured both in GitHub and the deployment.
- A token with only the permissions needed by project-owned Octokit calls.
- `application/json` selected as the webhook content type.

| Variable | Required | Purpose |
| --- | --- | --- |
| `GITHUB_WEBHOOK_SECRET` | Yes | Verifies inbound GitHub deliveries. |
| `GITHUB_TOKEN` | Yes | Authenticates outbound Octokit calls. |

For an installed GitHub App, application code remains responsible for
installation-specific token creation, selection, storage, and rotation.

## How to

1. Apply the documented blueprint using Bun:

   ```sh
   bunx flue add channel github
   ```

2. Review the generated `channels/github.ts`. It installs `@flue/github` and
   the official `@octokit/rest` SDK, and exports `channel`, `client`, and a
   destination-bound issue-comment tool.
3. Set `GITHUB_WEBHOOK_SECRET` and `GITHUB_TOKEN` in trusted server configuration.
4. Mount the channel:

   ```ts
   import { channel as github } from './channels/github.ts';

   app.route('/channels/github', github.route());
   ```

5. Configure this complete webhook URL in GitHub:

   ```txt
   https://example.com/channels/github/webhook
   ```

6. Keep SSL verification enabled, choose `application/json`, set the secret,
   and subscribe only to events the application handles.
7. Branch on `delivery.name` and, where applicable, `delivery.payload.action`.
   Return without dispatching for authenticated but irrelevant events.
8. Derive `{ owner, repo, issueNumber }` from the verified payload, dispatch a
   normalized signal, and bind the outbound tool from `initialData`.
9. Exercise signature failures, GitHub ping, each selected event/action,
   manual redelivery, and Octokit permission failures.

GitHub ping is acknowledged internally and does not reach the callback.

## Routing, dispatch, and outbound replies

The conventional route is:

```txt
POST /channels/github/webhook
```

Dispatch one conversation per issue or pull request:

```ts
const ref = {
  owner: repository.owner.login,
  repo: repository.name,
  issueNumber: issue.number,
};

await dispatch(Assistant, {
  id: channel.instanceId(ref),
  initialData: ref,
  message: {
    kind: 'signal',
    type: 'github.issue_comment.created',
    body: comment.body,
    attributes: {
      deliveryId: delivery.deliveryId,
      commentId: String(comment.id),
      sender: sender.login,
    },
  },
});
```

The full blueprint also routes newly created pull-request review comments.
Pull requests use their issue number for ordinary issue comments; review-thread
metadata remains useful when the application needs review-specific behavior.

For outbound replies, call `client.rest.issues.createComment()` inside a
`defineTool`. Bind owner, repository, and issue number in trusted code. The
model should choose only the comment body.

## Recommended patterns

- Subscribe to the minimum GitHub event set and filter again in the handler.
- Use namespaced signal types such as `github.issue_comment.created`.
- Put stable destination identity in `initialData` and per-delivery facts in attributes.
- Include installation identity in trusted state when credentials vary by installation.
- Admit work promptly and let the agent run asynchronously.
- Use GitHub's `X-GitHub-Delivery` identity for replay-safe application logic.

## Avoid

- Do not accept form-encoded webhook bodies; this ingress is JSON-only.
- Do not infer event shape without first narrowing `delivery.name` and action.
- Do not subscribe to every event and rely on the agent to decide what matters.
- Do not let the model select a repository, issue number, token, or Octokit method.
- Do not assume GitHub automatically retries failed webhook deliveries.
- Do not treat an instance id or caller-chosen agent URL as authorization.

## Security and idempotency gotchas

- `@flue/github` verifies the exact request against `GITHUB_WEBHOOK_SECRET` using GitHub's current scheme: an HMAC-SHA256 digest in `X-Hub-Signature-256`, formatted `sha256=<hex digest>`. GitHub's legacy `X-Hub-Signature` (HMAC-SHA1) is unsigned by comparison and exists only for backward compatibility on older webhook configs.
- Keep webhook secrets out of URL query strings and use public HTTPS with SSL verification.
- GitHub expects a `2xx` response within ten seconds and does not auto-retry failures.
- Failed deliveries can be manually redelivered with the same delivery id.
- The channel is stateless and does not deduplicate `delivery.deliveryId`.
- If duplicate admission matters, atomically claim the delivery id in durable
  application storage before dispatch. Preserve it in attributes for tracing.
- Token scopes must match only the outbound operations the tool exposes.
- Optional IP allowlisting supplements signature verification; GitHub's
  published hook addresses can change and must be refreshed if used.

## Related

- [Flue Channels guide](https://flueframework.com/docs/guide/channels/)
- [GitHub webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)
- [`@flue/github` README](https://github.com/withastro/flue/tree/main/packages/github#readme)
- `advanced_channels.md`
- `guides_routing.md`
