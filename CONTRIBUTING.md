# Contributing

## Repo Map

- `src/Domain`: Core logic and data models. Contains Effect Schemas for global
  configuration and logic for bucket matching.

- `src/Config`: Application configuration loading. Defines the HeraldConfig
  service layer.

- `src/Services`: Shared service abstractions and implementations.

  - `src/Services/Backend.ts`: Generic storage backend interface with structured
    request/response types and domain-specific error types.

  - `src/Services/BackendResolver.ts`: Logic for dynamically providing the
    correct backend based on request context.

  - `src/Services/S3Xml.ts`: S3-compatible XML response formatting for errors,
    bucket listings, and object listings.

- `src/Backends/S3`: S3 protocol implementation.

  - `src/Backends/S3/Backend.ts`: S3-specific implementation of the
    BackendService using AWS SDK, handling MinIO metadata stripping and encoding
    normalization.

  - `src/Backends/S3/Client.ts`: Low-level AWS SDK S3 client management and
    credential resolution.

  - `src/Backends/S3/Signer.ts`: AWS Signature Version 4 implementation for
    request signing.

- `src/Frontend`: HTTP ingress layer.

  - `src/Frontend/Api.ts`: HttpApi definition for the S3 compatibility layer.

  - `src/Frontend/Http.ts`: Main HTTP server setup and endpoint group
    registrations.

  - `src/Frontend/Utils.ts`: Shared frontend helpers for backend resolution and
    S3-compliant error mapping.

  - `src/Frontend/Buckets/`: Handlers for bucket-level S3 operations (Create,
    Delete, List, Head).

  - `src/Frontend/Objects/`: Handlers for object-level S3 operations (Get, Put,
    Delete, Head, List, Multi-Object Delete).

  - `src/Frontend/Health/`: Handlers for system health monitoring.

- `tests/`: Test suite.

  - `tests/integration/`: End-to-end tests comparing Herald proxy behavior
    against a MinIO baseline using snapshots.

  - `tests/config.test.ts`: Unit tests for configuration inheritance, glob
    matching, and backend resolution.

  - `tests/utils.ts`: Shared test harness, Effect-based assertions, and snapshot
    normalization logic.

- `x/`: CLI utilities and development scripts.

  - `x/s3-tests.ts`: Orchestration script for running the ceph `s3-tests` suite
    against the proxy.

  - `x/snapdiff.ts`: Tool for comparing Herald proxy snapshots against baseline
    responses.

  - `x/swift-s3-tests.ts`: Orchestration script for running the ceph `s3-tests`
    suite against the proxy with a Swift backend. Requires `infisical` for
    secrets.

    ```bash
    infisical run -- deno task test x/swift-s3-tests.ts
    ```

  - `x/utils.ts`: Shell scripting utilities powered by `dax`.

- `tools/`: Infrastructure and development tools.

  - `tools/compose.yml`: Docker configuration for local development services
    (MinIO, Redis).
