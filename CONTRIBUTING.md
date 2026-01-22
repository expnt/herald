# Contributing

## Starting Services

You can start the containers used for development using the provided scripts:

```bash
# Start MinIO and Redis
deno run --allow-all x/compose-up.ts s3 db

# Start Swift (SAIO)
deno run --allow-all x/compose-up.ts swift
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

- `chart/`: Helm charts for Kubernetes deployment.

- `tools/`: Infrastructure and development tools (Docker Compose,
  Containerfiles).
