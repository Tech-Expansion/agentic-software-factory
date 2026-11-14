# 0011. DevOps builds the pipeline; the owner deploys

Status: accepted
Date: 2026-11-14
Deciders: project owner

## Context

Nothing in the factory took a product from a merged commit to a running service. A deploy needs credentials, and the
factory's first rule is that agents never hold one (ADR 0001, ADR 0004): they run sandboxed, without secrets in their
environment, with network only to package registries.

## Decision

- **A DevOps engineer writes the delivery code**: CI, container images, infrastructure as code, deploy scripts,
  through the `infra` workflow (DevOps, checks, QA, and always the security reviewer). Its skill asks for pinned
  versions, least privilege, credentials read by name at deploy time, a plan before any change, and a rollback.
- **The runner deploys, when the owner says so.** `deploy: { <env>: [commands] }` in `project.yaml` (which agents
  cannot change) lists the commands. `asf deploy <env>` shows them, with the files that decide the deploy (the
  policy's approval paths) changed since the last deploy to that environment; `asf deploy <env> --yes` runs them from
  a clean base branch, outside the sandbox and with the owner's environment. `asf run --watch` never deploys.
- **Deploy files are approval paths by default** (`deploy*`, `deploy/`, `infra/`, `*.tf`, `k8s/`, `helm/`,
  compose files, GitLab CI, besides `.github/` and Dockerfiles), because a deploy command may call a script an agent
  wrote: such a change waits for the owner and brings in the security reviewer.
- **SRE, designed now and built after the first deployed product:** `commands.smoke` per environment, run by the
  runner after a deploy, with a failure reported and the rollback command offered; alerts or error logs read through
  a read-only endpoint the owner allows, turned by the product owner into bug items in the backlog. Nothing an agent
  does in production is unattended.

## Consequences

- Credentials stay where they are now: in the owner's environment or the platform's secret store, read by the
  owner's own process.
- The owner reads the deploy-relevant diff before the first deploy after it changed; the plan output makes that a
  list, not a search.
- Deploy commands run with full access to the owner's machine. That is the owner's own command in a protected file,
  as running a deploy by hand is; the scripts it calls are what the approval paths and the security review guard.
