## AWS Secrets Editor Web App

[![CI](https://github.com/eliauren/aws-secrets-editor-webapp/actions/workflows/ci.yml/badge.svg)](https://github.com/eliauren/aws-secrets-editor-webapp/actions/workflows/ci.yml)
[![Trivy](https://github.com/eliauren/aws-secrets-editor-webapp/actions/workflows/trivy.yml/badge.svg)](https://github.com/eliauren/aws-secrets-editor-webapp/actions/workflows/trivy.yml)
[![CodeQL](https://github.com/eliauren/aws-secrets-editor-webapp/actions/workflows/codeql.yml/badge.svg)](https://github.com/eliauren/aws-secrets-editor-webapp/actions/workflows/codeql.yml)
[![codecov](https://codecov.io/gh/eliauren/aws-secrets-editor-webapp/branch/main/graph/badge.svg)](https://codecov.io/gh/eliauren/aws-secrets-editor-webapp)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue?logo=docker)](https://github.com/eliauren/aws-secrets-editor-webapp/pkgs/container/aws-secrets-editor-webapp)
[![Dependabot](https://img.shields.io/badge/dependabot-enabled-025e8c?logo=dependabot)](https://github.com/eliauren/aws-secrets-editor-webapp/security/dependabot)

Web application to safely edit the `ALL_ORGANIZATIONS_SETTINGS` JSON value in AWS Secrets Manager, using AWS SSO for authentication.

### Features

- **SSO authentication** — connect via AWS SSO device flow directly from the browser, no static credentials needed.
- **Environment discovery** — automatically lists sandbox, staging, and production accounts accessible with your SSO session.
- **Tree-based JSON editor** — visual tree editor (powered by [vanilla-jsoneditor](https://github.com/josdejong/svelte-jsoneditor)) to add, edit, and delete nodes, arrays, and values. Switch to code mode for raw editing.
- **Diff review** — side-by-side diff view (additions/removals highlighted) before saving any changes.
- **Double confirmation** — type the environment name to confirm writes, preventing accidental updates.
- **Version history** — browse previous secret versions, view them read-only, and restore any past version.
- **Safe updates** — only the `ALL_ORGANIZATIONS_SETTINGS` key is modified; all other keys in the secret are preserved untouched.
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
docker pull ghcr.io/eliauren/aws-secrets-editor-webapp:latest

docker run --rm -p 3000:3000 \
  -v ~/.aws:/root/.aws:ro \
  ghcr.io/eliauren/aws-secrets-editor-webapp:latest
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

### Secret path convention

The secret is expected at `<environment>/marketplace/elasticbeanstalk/secrets` (e.g. `sandbox/marketplace/elasticbeanstalk/secrets`), where the environment name is derived from the AWS account name (lowercased).

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |

### Testing

```bash
npm test              # run tests once
npm run test:watch    # run in watch mode
npm run test:coverage # run with coverage report
```
