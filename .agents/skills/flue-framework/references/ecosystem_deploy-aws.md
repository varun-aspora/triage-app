---
title: Deploy Agents on AWS
source: https://flueframework.com/docs/ecosystem/deploy/aws/
flue_version: 2.0.8
nav_section: ecosystem/deploy
verified: 2026-09-17
platform_sources:
  - https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-overview.html
  - https://docs.aws.amazon.com/AmazonECR/latest/userguide/docker-push-ecr-image.html
  - https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specifying-sensitive-data-secrets.html
  - https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html
---

# Deploy Agents on AWS

## When to choose AWS

Choose AWS when the Flue Node target should run in your VPC beside RDS, Secrets Manager,
and existing AWS networking. Flue is a long-running HTTP server, not a function.

- ECS Express Mode is the recommended managed path: Fargate, ALB, TLS, networking,
  health checks, monitoring, and CPU autoscaling are provisioned together.
- EC2 is the simplest runtime model and gives full host control, with the most operations.
- ECS on Fargate is for teams that need explicit VPC, target group, task, and scaling control.
- AWS Lambda is not a supported target; its short-lived invocation model does not fit
  process-owned sessions, coordination, or long-lived conversation reads.

## Prerequisites

- AWS CLI authenticated to the target account and region.
- Docker and the Dockerfile from the Flue Docker deployment reference.
- An ECR repository and permission to push images.
- For Express Mode, an ECS task execution role and Express infrastructure role.
- A `/health` route in `app.ts` that returns `2xx` without model or database work.
- Secrets Manager or SSM parameters for provider credentials and `DATABASE_URL`.
- RDS PostgreSQL in reachable subnets/security groups when durable state is required.

## How to deploy with ECS Express Mode

### 1. Build and test the image

```bash
docker build --pull -t flue-agents:2.0.8 .
docker run --rm --init -p 8080:8080 \
  -e ANTHROPIC_API_KEY \
  flue-agents:2.0.8
curl --fail http://localhost:8080/health
```

The Dockerfile must set `PORT=8080`, expose `8080`, include production `node_modules`,
and start `node dist/server.mjs`.

### 2. Create ECR and push the image

```bash
aws ecr create-repository --repository-name flue-agents
aws ecr get-login-password --region <region> \
  | docker login --username AWS --password-stdin \
    <account>.dkr.ecr.<region>.amazonaws.com
docker tag flue-agents:2.0.8 \
  <account>.dkr.ecr.<region>.amazonaws.com/flue-agents:2.0.8
docker push <account>.dkr.ecr.<region>.amazonaws.com/flue-agents:2.0.8
```

Use an immutable tag or the pushed image digest in production. The execution role, not
the application task role, needs permission to pull the private image and resolve task
secret references.

### 3. Store runtime secrets

Create provider-key and database secrets in Secrets Manager or encrypted SSM Parameter
Store. Grant only the task execution role permission to resolve the values. In the ECS
container definition, map each to an environment variable through the `secrets` parameter:
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, and `DATABASE_URL` when configured.

Secret values are read when a task starts. After rotation, force a new ECS deployment so
new tasks receive the changed value.

### 4. Create the Express service

```bash
aws ecs create-express-gateway-service \
  --service-name flue-agents \
  --execution-role-arn arn:aws:iam::<account>:role/ecsTaskExecutionRole \
  --infrastructure-role-arn arn:aws:iam::<account>:role/ecsInfrastructureRoleForExpressServices \
  --primary-container '{
    "image": "<account>.dkr.ecr.<region>.amazonaws.com/flue-agents:2.0.8",
    "containerPort": 8080,
    "environment": [
      { "name": "MODEL_SPECIFIER", "value": "anthropic/claude-sonnet-4-6" }
    ]
  }' \
  --health-check-path /health \
  --scaling-target '{"minTaskCount":1,"maxTaskCount":4}' \
  --monitor-resources
```

The command response and ECS console expose the generated service URL and supporting
resources. Inject actual secrets as ECS task `secrets` references; do not place them in
the plaintext `environment` array shown for non-sensitive model configuration.

### 5. Verify and operate

```bash
curl --fail 'https://<service-url>/health'
curl -X POST 'https://<service-url>/agents/translator/demo-1' \
  -H 'Content-Type: application/json' \
  -d '{"kind":"user","body":"Translate to French: Hello"}'
```

Keep `minTaskCount` at least `1`. Inspect ECS task logs and ALB target health before
debugging Flue itself.

## EC2 alternative

Run the same ECR image on a single instance:

```bash
docker run -d --restart unless-stopped --init -p 80:8080 \
  --env-file /etc/flue-agents.env \
  <account>.dkr.ecr.<region>.amazonaws.com/flue-agents:2.0.8
```

Restrict the environment file to mode `600`; preferably populate it from SSM at boot.
Open the instance security group only to the intended ingress source. The Flue server
speaks plain HTTP, so terminate TLS with an ALB, nginx, or Caddy. A single EC2 process has
no automatic failover or scaling.

To run without Docker, build with `bunx vite build`, deploy `dist/` plus production
dependencies, and supervise `node dist/server.mjs` with systemd.

## Explicit ECS on Fargate alternative

Use a task definition and ECS service when Express Mode's generated topology is not
enough. The container definition references ECR, maps port `8080`, puts plaintext values
in `environment`, and maps Secrets Manager/SSM ARNs through `secrets`. For `awsvpc`
networking, the ALB target group must use target type `ip`. Allow the task security group
to receive `8080` only from the ALB security group.

Map the service load balancer to the container port, set target-group health path
`/health`, and set `healthCheckGracePeriodSeconds` beyond application startup. Configure
Application Auto Scaling only after persistence and instance-affine routing are in place.

## Environment and secrets

- The built server does not load `.env`; ECS, Docker, or systemd supplies the environment.
- `PORT`, image port, target group port, and health check must all match.
- Keep provider keys and `DATABASE_URL` in Secrets Manager or encrypted SSM parameters.
- Use task `environment` only for non-sensitive values such as an optional model specifier.
- A rotated ECS secret does not update running tasks; replace them.

## Persistence

Without `db.ts`, conversations, attachments, and accepted submissions are process-local
and disappear on task or instance replacement. Add the documented `@flue/postgres`
adapter and point `DATABASE_URL` at RDS PostgreSQL over the VPC. The adapter owns schema
creation and recovery records.

Shared RDS enables replacement recovery, not active-active processing. Each agent instance
must have one live owner even when the ECS service has several tasks.

## Health and streaming

Flue does not generate `/health`; define it in `app.ts`. ALB fronts long-poll/SSE
conversation `GET` reads, so raise the ALB idle timeout where required. Clients must retain
the admission's `streamUrl` and `offset` and resume after a dropped connection.

Allow enough ECS stop timeout and deployment drain time for graceful shutdown, but do not
equate an attached stream with accepted work: Flue continues accepted submissions using
durable evidence when a replacement owner can recover them.

## Recommended patterns

- Start with ECS Express Mode and one task; move to explicit Fargate only for needed control.
- Deploy immutable image tags or digests and force replacement after secret rotation.
- Keep tasks private behind an ALB and terminate TLS at the load balancer.
- Add RDS before rolling replacement or autoscaling.
- Correlate logs by conversation/submission and test stream reconnection during deploys.

## Avoid

- Do not deploy Flue to Lambda, request-scoped jobs, or scale-to-zero services.
- Do not bake provider keys, RDS credentials, or `.env` into the image.
- Do not expose the task directly to the internet when an ALB can front it.
- Do not round-robin the same agent instance across concurrent tasks.
- Do not use instance/container filesystems as durable conversation storage.

## Gotchas

- AWS closed App Runner to new customers; AWS's own migration guidance points existing
  App Runner users at ECS Express Mode, which is why this reference only covers ECS
  (Express Mode and explicit Fargate) and EC2.
- Express Mode still bills the underlying Fargate, ALB, logs, and transfer resources.
- ECR login tokens are region/account-specific; repository and image URI must agree.
- Fargate `awsvpc` target groups require `ip`, not `instance`, targets.
- A passing process check is not enough if the ALB checks a missing `/health` route.
- Secret rotation needs new tasks; changing the stored value alone is insufficient.
- Rolling deploy overlap can create two live owners unless routing and shutdown are planned.

## Related

- [Docker](https://flueframework.com/docs/ecosystem/deploy/docker/)
- [Node.js](https://flueframework.com/docs/ecosystem/deploy/node/)
- [Postgres](https://flueframework.com/docs/ecosystem/databases/postgres/)
- [Streaming protocol](https://flueframework.com/docs/reference/streaming-protocol/)
- [Amazon ECS Express Mode](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-overview.html)
