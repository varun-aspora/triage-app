---
title: Ecosystem Overview
source: https://flueframework.com/docs/ecosystem/
section: ecosystem
retrieved: 2026-09-17
---

# Ecosystem Overview

## Purpose and selection

The ecosystem page is Flue's directory of integration-specific guides. It groups
the current public pages by the boundary being integrated: inbound channels,
sandbox providers, deployment targets, databases, and developer tooling.

Use this index to select a category and then read the provider page. The index is
navigation, not a compatibility matrix or a shared installation guide. It does
not state that every integration supports both Node.js and Cloudflare.

| Need | Ecosystem section |
| --- | --- |
| Connect a named service to Flue | Channels |
| Give an agent a hosted execution environment | Sandboxes |
| Package or host a Flue application | Deploy |
| Back an application with a named data service | Databases |
| Trace, report, or evaluate agent behavior | Tooling |

## Prerequisites and environment

The overview documents no shared package, credential, environment variable, or
runtime prerequisite. Those details belong to each linked integration page.

Before selecting an integration, establish:

- the Flue deployment target;
- the exact external provider;
- where credentials can be held as secrets;
- whether application content may leave the deployment boundary;
- the provider-specific lifecycle and delivery guarantees.

These are selection checks, not configuration supplied by the overview.

## How to use the ecosystem

1. Choose the category matching the external boundary.
2. Open the exact provider page from the catalog below.
3. Follow that page's prerequisites, packages, configuration, and verification.
4. Check its runtime and deployment-target constraints.
5. Review content handling and secret storage before production use.

### Blueprint command

The overview itself documents no `flue add` blueprint command. Some tooling
pages do provide one; use the command in the relevant tooling reference rather
than assuming every ecosystem entry has a blueprint.

## Current catalog

### Channels

- [Discord](https://flueframework.com/docs/ecosystem/channels/discord/)
- [Facebook](https://flueframework.com/docs/ecosystem/channels/messenger/)
- [GitHub](https://flueframework.com/docs/ecosystem/channels/github/)
- [Google Chat](https://flueframework.com/docs/ecosystem/channels/google-chat/)
- [Intercom](https://flueframework.com/docs/ecosystem/channels/intercom/)
- [Linear](https://flueframework.com/docs/ecosystem/channels/linear/)
- [Microsoft Teams](https://flueframework.com/docs/ecosystem/channels/teams/)
- [Notion](https://flueframework.com/docs/ecosystem/channels/notion/)
- [Resend](https://flueframework.com/docs/ecosystem/channels/resend/)
- [Salesforce](https://flueframework.com/docs/ecosystem/channels/salesforce-marketing-cloud/)
- [Shopify](https://flueframework.com/docs/ecosystem/channels/shopify/)
- [Slack](https://flueframework.com/docs/ecosystem/channels/slack/)
- [Stripe](https://flueframework.com/docs/ecosystem/channels/stripe/)
- [Telegram](https://flueframework.com/docs/ecosystem/channels/telegram/)
- [Twilio](https://flueframework.com/docs/ecosystem/channels/twilio/)
- [WhatsApp](https://flueframework.com/docs/ecosystem/channels/whatsapp/)
- [Zendesk](https://flueframework.com/docs/ecosystem/channels/zendesk/)

### Sandboxes

- [Cloudflare Computer](https://flueframework.com/docs/ecosystem/sandboxes/cloudflare-computer/)
- [Cloudflare Sandbox](https://flueframework.com/docs/ecosystem/sandboxes/cloudflare/)
- [Daytona](https://flueframework.com/docs/ecosystem/sandboxes/daytona/)
- [E2B](https://flueframework.com/docs/ecosystem/sandboxes/e2b/)
- [Modal](https://flueframework.com/docs/ecosystem/sandboxes/modal/)
- [Vercel Sandbox](https://flueframework.com/docs/ecosystem/sandboxes/vercel/)
- [boxd](https://flueframework.com/docs/ecosystem/sandboxes/boxd/)
- [exe.dev](https://flueframework.com/docs/ecosystem/sandboxes/exedev/)
- [islo](https://flueframework.com/docs/ecosystem/sandboxes/islo/)
- [Mirage](https://flueframework.com/docs/ecosystem/sandboxes/mirage/)

### Deploy

- [AWS](https://flueframework.com/docs/ecosystem/deploy/aws/)
- [Cloudflare](https://flueframework.com/docs/ecosystem/deploy/cloudflare/)
- [Docker](https://flueframework.com/docs/ecosystem/deploy/docker/)
- [Fly.io](https://flueframework.com/docs/ecosystem/deploy/fly/)
- [GitHub Actions](https://flueframework.com/docs/ecosystem/deploy/github-actions/)
- [GitLab CI/CD](https://flueframework.com/docs/ecosystem/deploy/gitlab-ci/)
- [Node.js](https://flueframework.com/docs/ecosystem/deploy/node/)
- [Railway](https://flueframework.com/docs/ecosystem/deploy/railway/)
- [Render](https://flueframework.com/docs/ecosystem/deploy/render/)
- [SST](https://flueframework.com/docs/ecosystem/deploy/sst/)

### Databases

- [libSQL](https://flueframework.com/docs/ecosystem/databases/libsql/)
- [MongoDB](https://flueframework.com/docs/ecosystem/databases/mongodb/)
- [MySQL](https://flueframework.com/docs/ecosystem/databases/mysql/)
- [Postgres](https://flueframework.com/docs/ecosystem/databases/postgres/)
- [Redis](https://flueframework.com/docs/ecosystem/databases/redis/)
- [Supabase](https://flueframework.com/docs/ecosystem/databases/supabase/)
- [Turso](https://flueframework.com/docs/ecosystem/databases/turso/)
- [Valkey](https://flueframework.com/docs/ecosystem/databases/valkey/)

### Tooling

- [Braintrust](https://flueframework.com/docs/ecosystem/tooling/braintrust/)
- [OpenTelemetry](https://flueframework.com/docs/ecosystem/tooling/opentelemetry/)
- [Sentry](https://flueframework.com/docs/ecosystem/tooling/sentry/)
- [Vitest Evals](https://flueframework.com/docs/ecosystem/tooling/vitest-evals/)

The public overview retrieved on 2026-09-17 does not list Jetty. Flue 2.0.8
does bundle an `ecosystem/tooling/jetty` page; consult the local Jetty reference
for that versioned integration instead of treating its absence here as removal.

## Current APIs and configuration

The overview defines no API, package version, configuration shape, or environment
variable. Each catalog entry is a link to a dedicated guide.

## Recommended patterns

- Select by external boundary first, then by named provider.
- Read the provider page before adding packages or credentials.
- Re-check target-specific behavior when moving between Node.js and Cloudflare.
- Keep provider selection explicit in architecture and operational notes.
- Verify the integration at the same deployment boundary used in production.

## Avoid

- Do not infer install commands, APIs, or environment variables from a catalog label.
- Do not assume every ecosystem page has a generated blueprint.
- Do not assume a listed provider supports every Flue target.
- Do not treat tooling traces as eval assertions or CI gates.
- Do not treat an absent public-index entry as proof that no bundled guide exists.

## Gotchas

- Privacy and content rules are provider-specific; the index supplies none.
- Secret handling is provider-specific; the index supplies no shared env contract.
- Lifecycle and flush behavior vary by runtime and integration.
- Sampling behavior belongs to the tracing provider or SDK configuration.
- Eval stability depends on the eval harness, case isolation, and grading strategy.
- Catalog membership can differ from the pages bundled with a released Flue CLI.

## Related

- [Observability](https://flueframework.com/docs/guide/observability/)
- [Evals](https://flueframework.com/docs/guide/evals/)
- [Deploy](https://flueframework.com/docs/guide/deploy/)
- `ecosystem_tooling-braintrust.md`
- `ecosystem_tooling-jetty.md`
- `ecosystem_tooling-opentelemetry.md`
- `ecosystem_tooling-sentry.md`
- `ecosystem_tooling-vitest-evals.md`
