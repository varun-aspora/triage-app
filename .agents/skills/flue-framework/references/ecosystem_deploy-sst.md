---
title: Deploy Agents on SST
source: https://flueframework.com/docs/ecosystem/deploy/sst/
flue_version: 2.0.8
nav_section: ecosystem/deploy
verified: 2026-09-17
platform_sources:
  - https://sst.dev/docs/component/aws/service/
  - https://sst.dev/docs/component/aws/postgres/
  - https://sst.dev/docs/component/secret/
  - https://sst.dev/docs/start/aws/container/
---

# Deploy Agents on SST

## When to choose SST

Choose SST v3 when AWS infrastructure should be expressed in TypeScript and Flue should
run as an always-on Fargate container behind a load balancer. Use `sst.aws.Service`, not
Lambda: Flue owns a long-running Node server, in-process coordination, and streamed
conversation reads.

## Prerequisites

- AWS credentials usable by SST in the target account and region.
- SST v3 installed in the project.
- The Flue Dockerfile from the Docker deployment reference, listening on `8080`.
- A `/health` route in `app.ts`.
- A provider secret value for each SST stage.
- `@flue/postgres`, `pg`, and `src/db.ts` when state must survive task replacement.

## How to deploy

### 1. Install and initialize SST

```bash
bun add -d sst
bunx sst init
```

Keep the generated `/// <reference path="./.sst/platform/config.d.ts" />` line. This guide
matches SST v3's Ion component API; recheck component fields before upgrading SST.

### 2. Define the always-on service

```ts
// sst.config.ts
/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: 'flue-agents',
      home: 'aws',
      removal: input.stage === 'production' ? 'retain' : 'remove',
    };
  },
  async run() {
    const vpc = new sst.aws.Vpc('FlueVpc');
    const cluster = new sst.aws.Cluster('FlueCluster', { vpc });

    new sst.aws.Service('Flue', {
      cluster,
      image: { context: '.', dockerfile: 'Dockerfile' },
      loadBalancer: {
        rules: [{ listen: '80/http', forward: '8080/http' }],
        health: {
          '8080/http': { path: '/health' },
        },
      },
    });
  },
});
```

The `forward` port must match the Dockerfile's `PORT=8080`. SST builds the Docker image,
pushes it to ECR, and provisions the VPC, ECS cluster/service, and load balancer.

### 3. Add and set the provider secret

Declare the secret and expose it as the process environment expected by Flue/provider code:

```ts
const apiKey = new sst.Secret('AnthropicApiKey');

new sst.aws.Service('Flue', {
  cluster,
  image: { context: '.', dockerfile: 'Dockerfile' },
  loadBalancer: {
    rules: [{ listen: '80/http', forward: '8080/http' }],
    health: { '8080/http': { path: '/health' } },
  },
  link: [apiKey],
  environment: {
    ANTHROPIC_API_KEY: apiKey.value,
    MODEL_SPECIFIER: 'anthropic/claude-sonnet-4-6',
  },
});
```

```bash
bunx sst secret set AnthropicApiKey sk-ant-...
```

Set it separately for each stage. `link` grants resource access; `environment` is required
because the generated Flue server reads `process.env` and does not import SST `Resource`.

### 4. Add Postgres for durability

```bash
bun add @flue/postgres@2.0.8 pg
```

Create `src/db.ts` using the complete Flue Postgres adapter, then extend the config:

```ts
const db = new sst.aws.Postgres('FlueDb', { vpc });

new sst.aws.Service('Flue', {
  cluster,
  image: { context: '.', dockerfile: 'Dockerfile' },
  loadBalancer: {
    rules: [{ listen: '80/http', forward: '8080/http' }],
    health: { '8080/http': { path: '/health' } },
  },
  link: [apiKey, db],
  environment: {
    ANTHROPIC_API_KEY: apiKey.value,
    MODEL_SPECIFIER: 'anthropic/claude-sonnet-4-6',
    DATABASE_URL: $interpolate`postgresql://${db.username}:${db.password}@${db.host}:${db.port}/${db.database}`,
  },
});
```

The database and service share the VPC. Flue discovers `db.ts` at image build time and
uses `DATABASE_URL` for canonical streams, attachments, and durable submissions.

### 5. Preview and deploy a stage

```bash
bunx sst deploy --stage dev
bunx sst deploy --stage production
```

The command prints the service endpoint. Verify it:

```bash
curl --fail 'http://<load-balancer-url>/health'
curl -X POST 'http://<load-balancer-url>/agents/translator/demo-1' \
  -H 'Content-Type: application/json' \
  -d '{"kind":"user","body":"Translate to French: Hello"}'
```

Add an HTTPS custom domain before production traffic when plaintext HTTP is unacceptable.

## Environment and secrets

- Set `sst.Secret` values per stage; do not commit them to `sst.config.ts`.
- Link alone does not create `process.env.ANTHROPIC_API_KEY`; map `apiKey.value` explicitly.
- Use the provider's expected variable name and model namespace.
- The built server does not load `.env` in Fargate.
- Treat SST outputs and deployment logs as sensitive when reviewing interpolated resources.

## Persistence

Without `db.ts`, every Fargate replacement loses conversations, attachments, and accepted
submissions. `sst.aws.Postgres` plus the Flue adapter provides replacement recovery.
Setting `removal: 'retain'` for production protects SST-managed infrastructure on stack
removal, but is not a substitute for database backup and restore policy.

Shared Postgres does not support simultaneous owners of one agent instance. Start with one
task; design affinity and non-overlap before enabling `scaling`.

## Health and streaming

An SST load balancer always health-checks its target and defaults to `/`. Since Flue adds
no route there, configure `loadBalancer.health['8080/http'].path = '/health'`. SST's
container-level `health` is separate and disabled by default.

ALB idle timeouts can end long-poll/SSE reads. Retain `streamUrl` and `offset`, configure
the load balancer for expected stream duration, and reconnect after task replacement.

## Recommended patterns

- Use normal Fargate for production; reserve Fargate Spot for disposable dev/PR stages.
- Retain production data resources and remove ephemeral stages.
- Keep the image port, forwarded port, and health-check key at `8080/http` together.
- Set secrets per stage before deploying and rotate them through planned task replacement.
- Add Postgres before scaling and test recovery during `sst deploy`.

## Avoid

- Do not put the Flue server in `sst.aws.Function` or API Gateway Lambda integration.
- Do not rely on `link` without mapping values required in `process.env`.
- Do not expose production on HTTP without a TLS/custom-domain listener.
- Do not enable Spot for the sole production owner without accepting interruption.
- Do not scale tasks before durable storage and instance-affine ownership exist.

## Gotchas

- SST component APIs move quickly; this reference is explicitly SST v3 and Flue 2.0.8.
- Changing Fargate capacity can recreate the ECS service and cause temporary downtime.
- Load-balancer health and ECS container health are independent settings.
- The default load-balancer path `/` fails if the app only defines `/health`.
- ALB cost is separate from Fargate, public IPv4, logs, RDS, and data transfer.
- `sst remove --stage <name>` can destroy non-retained stage resources.

## Related

- [Docker](https://flueframework.com/docs/ecosystem/deploy/docker/)
- [AWS](https://flueframework.com/docs/ecosystem/deploy/aws/)
- [Node.js](https://flueframework.com/docs/ecosystem/deploy/node/)
- [Postgres](https://flueframework.com/docs/ecosystem/databases/postgres/)
- [SST Service](https://sst.dev/docs/component/aws/service/)
