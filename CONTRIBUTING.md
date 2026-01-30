# Contributing

## Requirements

There's a nix flake at [`flake.nix`](./flake.nix) that provisions all dependencies required for development.
Namely:
- [Deno](https://deno.com/): the javascript runtime in use.
- [uv](https://docs.astral.sh/uv/): python package and runtime manager used for [s3-tests](./s3-tests/).
- [Prek](https://prek.j178.dev/): the pre-commit hook runner.

## Environment

Herald reads configuration from the process environment (see main README). For
local development, copy `.env.example` to `.env` and set variables (e.g.
`HERALD_*`, Swift test creds). `.env` is gitignored; never commit secrets.

## Starting Services

You can start the containers used for development using the provided scripts:

```bash
# Start MinIO and SAIO
deno run -A x/compose-up.ts s3 swift
```

## Running Tests

```bash
# Run all tests
deno task test

# Run Swift integration tests specifically
deno task test --filter "Swift/"
```

## Benchmarking

```bash
deno bench --allow-all benchmarks/
```

## Repo Map

- `src/Domain`: Core logic and data models. Contains Effect Schemas for global
  configuration and logic for backend resolution/matching.

- `src/Config`: Application configuration loading. Defines the HeraldConfig
  service layer.

- `src/Services`: Shared service abstractions and implementations.
  - `src/Services/Backend.ts`: Generic storage backend interface with structured
    request/response types and domain-specific error types.
  - `src/Services/BackendResolver.ts`: Logic for dynamically providing the
    correct backend based on request context.
  - `src/Services/S3Xml.ts`: S3-compatible XML response formatting for errors,
    bucket listings, and object listings.
  - `src/Services/BackendKeyValueStore.ts`: Abstraction for backend-specific
    key-value storage.

- `src/Backends`: Specific storage backend implementations.
  - `src/Backends/S3`: S3 protocol implementation using AWS SDK.
  - `src/Backends/Swift`: OpenStack Swift protocol implementation.

- `src/Frontend`: HTTP ingress layer.
  - `src/Frontend/Api.ts`: HttpApi definition for the S3 compatibility layer.
  - `src/Frontend/Http.ts`: Main HTTP server setup and endpoint group
    registrations.
  - `src/Frontend/Buckets/`: Handlers for bucket-level S3 operations.
  - `src/Frontend/Objects/`: Handlers for object-level S3 operations, including
    Multipart Upload (via `Post.ts`).
  - `src/Frontend/Health/`: Handlers for system health monitoring.

- `src/Logging` & `src/Tracing.ts`: Diagnostic observability layers.

- `tests/`: Test suite.
  - `tests/integration/`: End-to-end tests comparing Herald proxy behavior
    against a MinIO baseline using snapshots.
  - `tests/config.test.ts`: Unit tests for configuration and backend resolution.
  - `tests/utils.ts`: Shared test harness and snapshot normalization logic.

- `benchmarks/`: Performance testing suite for evaluating proxy overhead and
  streaming efficiency.

- `x/`: CLI utilities and development scripts.
  - `x/dev.ts`: Main development entry point for running the proxy locally.
  - `x/s3-tests.ts`: Orchestration for running the ceph `s3-tests` suite.
  - `x/snapdiff.ts`: Tool for comparing proxy snapshots against baseline
    responses.
  - `x/compose-up.ts` & `x/compose-down.ts`: Helpers for managing local Docker
    dependencies.

- `chart/`: Helm chart for Kubernetes deployment.

- `tools/`: Infrastructure and development tools (Docker Compose,
  Containerfiles).

### Repo features

- **Nix flake** (`flake.nix`): Dev shell with Deno, uv, prek, infisical, etc.
  Run `nix develop` to enter the environment; `x/` is on `PATH`.

- **Commitizen** (`.cz.yaml`): Conventional commits and changelog bumps. Use
  `cz` or `prek` to commit; version and `CHANGELOG.md` are updated on bump.

- **Pre-commit** (`.pre-commit-config.yaml`): Hooks for deno fmt/lint/check,
  YAML/JSON checks, trailing whitespace, etc. CI runs `prek run --all-files`
  (see `.github/workflows/checks.yml`).

- **GitHub Actions** (`.github/workflows/`):
  - `pr-title-check.yml`: Enforces semantic pull request titles (e.g.
    `feat(proxy): add X`) via amannn/action-semantic-pull-request.
  - `checks.yml`: On push/PR — Nix dev shell, pre-commit hooks, deno cache, uv
    cache, tests; submodules included.
  - `build-image.yml`: Builds and pushes OCI image (e.g. ghcr.io) on push to
    main when `src/` or `tools/` change; supports pull_request for validation.
