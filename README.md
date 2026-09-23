## AWS Secrets Editor Web App

[![CI](https://github.com/o5r/aws-secrets-editor-webapp/actions/workflows/ci.yml/badge.svg)](https://github.com/o5r/aws-secrets-editor-webapp/actions/workflows/ci.yml)
[![Trivy](https://github.com/o5r/aws-secrets-editor-webapp/actions/workflows/trivy.yml/badge.svg)](https://github.com/o5r/aws-secrets-editor-webapp/actions/workflows/trivy.yml)
[![CodeQL](https://github.com/o5r/aws-secrets-editor-webapp/actions/workflows/codeql.yml/badge.svg)](https://github.com/o5r/aws-secrets-editor-webapp/actions/workflows/codeql.yml)
[![codecov](https://codecov.io/gh/o5r/aws-secrets-editor-webapp/branch/main/graph/badge.svg)](https://codecov.io/gh/o5r/aws-secrets-editor-webapp)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue?logo=docker)](https://github.com/o5r/aws-secrets-editor-webapp/pkgs/container/aws-secrets-editor-webapp)
[![Dependabot](https://img.shields.io/badge/dependabot-enabled-025e8c?logo=dependabot)](https://github.com/o5r/aws-secrets-editor-webapp/security/dependabot)

Web application to safely edit the `ALL_ORGANIZATIONS_SETTINGS` JSON value in AWS Secrets Manager, using AWS SSO for authentication.

### Features

- **SSO authentication** — connect via AWS SSO device flow directly from the browser, no static credentials needed.
- **Environment discovery** — automatically lists sandbox, staging, and production accounts accessible with your SSO session.
- **Tree-based JSON editor** — visual tree editor (powered by [vanilla-jsoneditor](https://github.com/josdejong/svelte-jsoneditor)) to add, edit, and delete nodes, arrays, and values. Switch to code mode for raw editing.
- **Diff review** — side-by-side diff view (additions/removals highlighted) before saving any changes.
- **Double confirmation** — type the environment name to confirm writes, preventing accidental updates.
- **Version history** — browse previous secret versions, view them read-only, and restore any past version.
- **Safe updates** — only the `ALL_ORGANIZATIONS_SETTINGS` key is modified; all other keys in the secret are preserved untouched.
- **Marketplace API restart** — force a new ECS deployment of the `web`, `worker` and `cron` services so the running tasks pick up the new secret, with live rollout tracking and hard safeguards on production.
- **Rate limiting** — SSO and write endpoints are rate-limited to prevent abuse.

### Prerequisites

- Node.js 25+
- AWS CLI configured on the host with at least one SSO profile (`aws configure sso`).

### Install and run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000` in your browser, select your SSO profile, and click **Connect with SSO**.

### Run from GitHub Container Registry

```bash
docker pull ghcr.io/o5r/aws-secrets-editor-webapp:latest

docker run --rm -p 3000:3000 \
  -v ~/.aws:/root/.aws:ro \
  ghcr.io/o5r/aws-secrets-editor-webapp:latest
```

### Build and run locally with Docker

```bash
docker build -t aws-secrets-editor .

docker run --rm -p 3000:3000 \
  -v ~/.aws:/root/.aws:ro \
  aws-secrets-editor
```

The `~/.aws` mount gives the container read-only access to your SSO profile definitions in `~/.aws/config`.

### Usage

1. **SSO Connection** — select an SSO session and authenticate via the device flow link.
2. **Environment** — pick a sandbox, staging, or production account from the discovered environments.
3. **Edit** — the `ALL_ORGANIZATIONS_SETTINGS` value is loaded into a tree editor. Add, edit, or remove organization settings as needed.
4. **Review & Save** — click "Review Changes" to see a diff, then confirm by typing the environment name.
5. **Restart** — after saving, restart the marketplace API services so the new secret is actually loaded (see below).

### Restarting the marketplace API

ECS tasks read Secrets Manager values at startup, so a secret update has no effect until the
tasks are replaced. The marketplace API runs as **three** services that all load the secret:

| Role | Example service name |
|------|----------------------|
| `web` | `sandbox-marketplace-api-web` |
| `worker` | `sandbox-marketplace-api-worker` |
| `cron` | `sandbox-marketplace-api-cron` |

The sidebar of step 3 lists them for the selected environment with all restartable ones
pre-selected. **Restart** issues an ECS `UpdateService` with `forceNewDeployment: true` on each
selected service, then polls every 10s until every rollout completes or one fails.

Safeguards — the backend re-validates everything, the UI guards are only a first line of defence:

- Only services recognised as part of the marketplace API can be restarted. Targets are
  re-resolved server-side, so the endpoint cannot be used to restart an arbitrary ECS service.
- The environment name must be typed to confirm, and **production additionally requires an
  explicit acknowledgement checkbox**.
- A service with a desired count of `0` is never restarted.
- A restart is refused while a deployment is already in progress (unless explicitly forced).
- **All targets are validated before any `UpdateService` call**, so a rejected batch never
  leaves the three services in a half-restarted state.
- The restart endpoint is rate-limited to 3 requests per 5 minutes.

#### Service matching

A service belongs to the marketplace API when its name contains **every** required token
(case-insensitive). Default: `marketplace,api` — which matches the `-web`, `-worker` and `-cron`
variants. Override `MARKETPLACE_API_SERVICE_TOKENS` if the infrastructure naming changes. The
role shown in the UI is derived from the `web` / `worker` / `cron` suffix.

#### Required IAM permissions

The SSO permission set used to connect must additionally allow:

```
ecs:ListClusters
ecs:ListServices
ecs:DescribeServices
ecs:UpdateService
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `MARKETPLACE_API_SERVICE_TOKENS` | `marketplace,api` | Comma-separated tokens an ECS service name must **all** contain to be considered part of the marketplace API |

### Testing

```bash
npm test              # run tests once
npm run test:watch    # run in watch mode
npm run test:coverage # run with coverage report
```
