# Contributing

## Repo Map

- `src/Domain`: Core logic and data models. Contains Effect Schemas for global
  configuration and logic for bucket matching.

- `src/Config`: Application configuration loading. Defines the AppConfig service
  layer.

- `src/Services`: Shared service abstractions and implementations.

  - `src/Services/Backend.ts`: Generic storage backend interface and
    domain-specific error types.

  - `src/Services/BackendResolver.ts`: Logic for dynamically providing the
    correct backend based on request context.

  - `src/Services/S3Xml.ts`: S3-compatible XML response and error formatting.

- `src/Backends/S3`: S3 protocol implementation.

  - `src/Backends/S3/Backend.ts`: S3-specific implementation of the
    BackendService using AWS SDK.

  - `src/Backends/S3/Client.ts`: Low-level S3 client management and raw HTTP
    proxying logic.

  - `src/Backends/S3/Signer.ts`: AWS Signature Version 4 implementation for
    request signing.

- `src/Frontend`: HTTP ingress layer.

  - `src/Frontend/Api.ts`: HttpApi definition for the S3 compatibility layer.

  - `src/Frontend/Http.ts`: Main HTTP server setup and endpoint group
    registrations.

  - `src/Frontend/Utils.ts`: Shared frontend helpers for backend resolution and
    error handling.

  - `src/Frontend/Buckets/`: Handlers for bucket-level S3 operations.

  - `src/Frontend/Health/`: Handlers for system health monitoring.

- `tests/`: Test suite.

  - `tests/integration/`: End-to-end tests comparing proxy behavior against a
    MinIO baseline.

  - `tests/config.test.ts`: Unit tests for configuration inheritance and glob
    matching.

  - `tests/utils.ts`: Shared test harness, Effect-based assertions, and snapshot
    normalization logic.

- `x/`: CLI utilities and development scripts.

  - `x/snapdiff.ts`: Tool for comparing Herald proxy snapshots against baseline
    responses.

- `tools/`: Infrastructure and development tools.

  - `tools/compose.yml`: Docker configuration for local development services
    (MinIO, Redis).
