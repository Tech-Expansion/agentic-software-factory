---
name: devops-pipeline
description: Build or change CI, container images, infrastructure as code and deploy scripts, safely and reproducibly.
---

1. Read the item, the product's existing CI, Dockerfile, infrastructure and deploy files, and the docs on how the
   product runs. Extend what is there.
2. CI: run the product's checks (`commands.check`) on every change; cache dependencies by lockfile; pin actions and
   tool versions; give the workflow only the permissions it needs.
3. Images: a small, pinned base image; a non-root user; no secrets in layers or build args; build the same way
   locally and in CI.
4. Infrastructure as code: plan before apply; state stored remotely, never committed; resources named and tagged by
   environment; nothing reachable from the internet unless the item asks for it.
5. Deploy scripts: take the environment as an argument; read credentials from the environment by name and fail with a
   clear message when one is missing; print what will change before changing it; exit non-zero on any failure;
   document the rollback.
6. Check what you can locally without credentials: the checks, a build of the image, a dry run or a plan.

Name every credential and setting the owner must provide in your final message and in the docs, never its value.
