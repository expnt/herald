<p align="center">
    <img src="herald.jpeg" align="center" width="30%">
</p>
<p align="center"><h1 align="center">herald</h1></p>
<p align="center">
	<em>herald: Orchestrating object storage services</em>
</p>
<p align="center">
	<img src="https://img.shields.io/github/license/expnt/herald?style=default&logo=opensourceinitiative&logoColor=white&color=0080ff" alt="license">
	<img src="https://img.shields.io/github/last-commit/expnt/herald?style=default&logo=git&logoColor=white&color=0080ff" alt="last-commit">
	<img src="https://img.shields.io/github/languages/top/expnt/herald?style=default&color=0080ff" alt="repo-top-language">
	<img src="https://img.shields.io/github/languages/count/expnt/herald?style=default&color=0080ff" alt="repo-language-count">
</p>
<p align="center"><!-- default option, no dependency badges. -->
</p>
<p align="center">
	<!-- default option, no dependency badges. -->
</p>
<br>

Herald is an S3 proxy that supports:

- Protocol translation (S3 to S3, S3 to Swift).
- Backend routing based on bucket names.
- Flexible bucket mapping with glob support.

## Quick start

Run Herald in Docker with env-only config (no YAML). Point it at an
S3-compatible backend (e.g. [MinIO](https://min.io)) and use any S3 client
against Herald.

```bash
# Start Herald (default backend: S3 at host's MinIO). Port 3000.
docker run -p 3000:3000 \
  -e HERALD_DEFAULT_PROTOCOL=s3 \
  -e HERALD_DEFAULT_ENDPOINT=http://host.docker.internal:9000 \
  -e HERALD_DEFAULT_REGION=us-east-1 \
  -e HERALD_DEFAULT_ACCESS_KEY_ID=minioadmin \
  -e HERALD_DEFAULT_SECRET_ACCESS_KEY=minioadmin \
  ghcr.io/expnt/herald:latest
```

Use the AWS CLI (or any S3 client) with Herald as the endpoint. The S3 API is
mounted at `/s3`; use path-style so bucket and key are in the path.

```bash
# List buckets via Herald
aws s3 ls --endpoint-url http://localhost:3000/s3

# List objects in a bucket
aws s3 ls --endpoint-url http://localhost:3000/s3 s3://my-bucket/
```

Deployment resources:

- **Images:** [ghcr.io/expnt/herald](https://ghcr.io/expnt/herald)
- **Helm chart:** [chart/](chart/) for Kubernetes.

## Config

Herald is configured via a YAML file (typically `herald.yaml`). The
configuration defines backends and how incoming requests are routed to them.

```yaml
backends:
  # Unique identifier for the backend
  minio:
    # Backend protocol: "s3" or "swift"
    protocol: s3

    # Base URL of the backend service
    endpoint: http://127.0.0.1:9000

    # Default region for this backend
    region: us-east-1

    # Authentication credentials for the backend
    credentials:
      accessKeyId: minioadmin
      secretAccessKey: minioadmin

    # Bucket routing rules.
    # Can be:
    # 1. "*" to match all buckets not claimed by other backends
    # 2. A glob pattern like "logs-*"
    # 3. A map of bucket definitions for granular control
    # Optional: auth for this backend (bucket > backend > global)
    auth:
      accessKeysRefs: [admin]

    buckets:
      # Simple bucket mapping (inherits backend settings)
      my-bucket: {}

      # Mapping with overrides; bucket-level auth overrides backend/global
      external-data:
        auth:
          accessKeysRefs: [readonly]
        # Map proxy bucket "external-data" to backend bucket "data-v1"
        bucket_name: data-v1
        # Override endpoint for this specific bucket
        endpoint: http://special-endpoint:9000
        # Override region
        region: us-west-2

      # Glob pattern support within the map
      "test-*":
        region: us-east-1

  # Example Swift backend
  swift-storage:
    protocol: swift
    auth_url: http://keystone.example.com/v3
    region: RegionOne
    # Optional: override the Swift container name for all buckets in this backend
    # container: my-fixed-container
    credentials:
      username: my-user
      password: my-password
      project_name: my-project
      user_domain_name: Default
      project_domain_name: Default
    # Route all archive buckets to Swift
    buckets: "archive-*"

# Optional: require S3 SigV4 auth for incoming requests (see Auth section)
auth:
  accessKeysRefs: [admin, readonly]

cors:
  # Global CORS defaults
  allowedOrigins: ["*"]
  allowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD", "OPTIONS"]
  allowedHeaders: ["*"]
  exposedHeaders: ["*"]
  maxAge: 3600
  credentials: false
```

### Auth (incoming request verification)

Herald can verify incoming S3 requests using AWS Signature Version 4 (SigV4).
When auth is configured, only requests signed with one of the configured access
keys are accepted. Credentials are never stored in the config file; you
reference them by name (_refs_) and supply the actual keys via environment
variables.

#### Precedence

Auth is resolved at three levels with the same precedence as CORS: **Bucket >
Backend > Global**. The most specific definition wins (e.g. a bucket’s `auth`
overrides its backend’s `auth`).

#### Config shape

At each level you set `auth.accessKeysRefs`: a list of ref names (strings). Each
ref maps to a pair of env vars:

- `HERALD_AUTH_<REF>_ACCESS_KEY_ID` — access key id
- `HERALD_AUTH_<REF>_SECRET_KEY` — secret key

`<REF>` is the ref name in UPPERCASE (e.g. ref `admin` →
`HERALD_AUTH_ADMIN_ACCESS_KEY_ID`). Only refs that have both env vars set are
used; missing refs are skipped.

Example: global `auth.accessKeysRefs: [admin, readonly]` with
`HERALD_AUTH_ADMIN_ACCESS_KEY_ID`, `HERALD_AUTH_ADMIN_SECRET_KEY` and
`HERALD_AUTH_READONLY_ACCESS_KEY_ID`, `HERALD_AUTH_READONLY_SECRET_KEY` set in
the environment allows requests signed with either key. You can override at
backend or bucket level (e.g. a backend that only accepts `admin`, or a bucket
that only accepts `readonly`).

#### When auth is not configured

If no `auth` is defined at any level for a request, Herald does not perform
SigV4 verification and the request is not gated by these credentials.

### CORS Configuration

Herald supports fine-grained CORS control at three levels with the following
precedence: **Bucket > Backend > Global**.

- **Global**: Defined at the root of the config file under `cors`.
- **Backend**: Defined within a backend block under `cors`. Overrides global
  settings.
- **Bucket**: Defined within a bucket definition under `cors`. Overrides both
  backend and global settings.

#### Default Behavior

If no CORS configuration is provided at any level, **CORS is disabled** and
Herald will not add any CORS-related headers to responses. Preflight `OPTIONS`
requests will be passed through to the backend.

If you enable CORS by providing configuration at any level, the following
defaults are applied for any omitted fields:

| Field            | Default Value                           | Description                                            |
| ---------------- | --------------------------------------- | ------------------------------------------------------ |
| `maxAge`         | `3600`                                  | Max age in seconds for preflight results               |
| `allowedMethods` | `GET, PUT, POST, DELETE, HEAD, OPTIONS` | Allowed HTTP methods                                   |
| `allowedHeaders` | (Mirrors request)                       | Defaults to mirroring `Access-Control-Request-Headers` |
| `credentials`    | `false`                                 | Whether to allow credentials                           |
| `allowedOrigins` | (None)                                  | Headers only added if `Origin` matches an entry        |

Example with overrides:

```yaml
cors: # Global defaults
  allowedOrigins: ["*"]
  credentials: false

backends:
  prod:
    protocol: s3
    cors: # Backend-level override
      allowedOrigins: ["https://app.example.com"]
      credentials: true
    buckets:
      assets:
        cors: # Bucket-level override
          allowedOrigins: ["https://cdn.example.com"]
```

### Routing Logic

When a request comes in for a bucket (e.g., `GET /my-bucket/file.txt`), Herald
resolves the backend using the following priority:

1. **Direct match**: Looks for `my-bucket` in all backends' `buckets` maps.
2. **Glob match (map)**: Looks for glob patterns (like `test-*`) in all
   backends' `buckets` maps.
3. **Glob match (string)**: If a backend has `buckets: "string-*"`, it checks if
   the bucket name matches that pattern.

When several backends could match (e.g. two globs), the **first backend in
config order** wins.

### Environment variable configuration

Configuration can be supplied or overridden via environment variables; env is
merged with YAML at load time (env wins for the same path). All config-related
vars use the `HERALD_` prefix. Naming: `HERALD_<KEY>` applies to the `default`
backend or global (for top-level keys like auth/CORS); `HERALD_<BACKEND>_<KEY>`
applies to that backend. Keys are normalised (e.g. `AUTH_URL` → `auth_url`;
credential keys go under `credentials`).

| Var                                                                                                                                                                                                                               | Purpose                                 | Default       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------- |
| `HERALD_CONFIG_PATH`                                                                                                                                                                                                              | Path to YAML config file                | `herald.yaml` |
| `HERALD_LOG_LEVEL`                                                                                                                                                                                                                | Log level (e.g. `DEBUG`, `INFO`)        | (none; INFO)  |
| `PORT`                                                                                                                                                                                                                            | HTTP server port                        | `3000`        |
| `HERALD_AUTH_ACCESS_KEYS_REFS`                                                                                                                                                                                                    | Global auth: comma-separated ref names  | —             |
| `HERALD_<BACKEND>_AUTH_ACCESS_KEYS_REFS`                                                                                                                                                                                          | Backend auth: comma-separated ref names | —             |
| `HERALD_AUTH_<REF>_ACCESS_KEY_ID`                                                                                                                                                                                                 | Access key for auth ref (SigV4)         | —             |
| `HERALD_AUTH_<REF>_SECRET_KEY`                                                                                                                                                                                                    | Secret key for auth ref (SigV4)         | —             |
| `HERALD_PROTOCOL`, `HERALD_ENDPOINT`, `HERALD_REGION`, `HERALD_BUCKETS`                                                                                                                                                           | Default backend (S3)                    | —             |
| `HERALD_<BACKEND>_PROTOCOL`, `HERALD_<BACKEND>_ENDPOINT`, `HERALD_<BACKEND>_REGION`, `HERALD_<BACKEND>_BUCKETS`                                                                                                                   | Backend (S3)                            | —             |
| `HERALD_<BACKEND>_ACCESS_KEY_ID`, `HERALD_<BACKEND>_SECRET_ACCESS_KEY`                                                                                                                                                            | Backend S3 credentials                  | —             |
| `HERALD_<BACKEND>_AUTH_URL`, `HERALD_<BACKEND>_CONTAINER`, `HERALD_<BACKEND>_USERNAME`, `HERALD_<BACKEND>_PASSWORD`, `HERALD_<BACKEND>_PROJECT_NAME`, `HERALD_<BACKEND>_USER_DOMAIN_NAME`, `HERALD_<BACKEND>_PROJECT_DOMAIN_NAME` | Backend (Swift)                         | —             |
| `HERALD_CORS_ALLOWED_ORIGINS`, `HERALD_CORS_ALLOWED_METHODS`, `HERALD_CORS_ALLOWED_HEADERS`, `HERALD_CORS_EXPOSED_HEADERS`, `HERALD_CORS_MAX_AGE`, `HERALD_CORS_CREDENTIALS`                                                      | Global CORS (lists comma-separated)     | —             |
| `HERALD_<BACKEND>_CORS_<KEY>`                                                                                                                                                                                                     | Backend CORS (same keys as above)       | —             |

### Health and observability

- **Health:** `GET /health` returns `{ "status": "ok" }`. Use it for
  liveness/readiness.
- **Logging:** Set `HERALD_LOG_LEVEL` (e.g. `DEBUG`, `INFO`) to control log
  verbosity.
- **Tracing:** Optional OpenTelemetry: set `OTEL_EXPORTER_OTLP_ENDPOINT` (and
  `OTEL_SERVICE_NAME`, default `herald`) to export traces to an OTLP collector.

## Deployment

- **Docker:** Images are published at
  [ghcr.io/expnt/herald](https://ghcr.io/expnt/herald). Use env vars (see table
  above) or mount a `herald.yaml` and set `HERALD_CONFIG_PATH`.
- **Kubernetes:** A Helm chart is in [chart/](chart/).

## Limitations

Herald is an S3 proxy focused on routing, protocol translation, and core object
operations. The following are **not** currently supported (or are partial):

- **Bucket subresources:** Bucket policies (`?policy`), lifecycle
  (`?lifecycle`), versioning config (`?versioning`), tagging (`?tagging`), ACLs
  (`?acl`), website (`?website`), public access block (`?publicAccessBlock`),
  replication, logging, inventory, metrics, ownership controls.
- **Object subresources:** Object ACLs, tagging, legal hold, retention (Object
  Lock), S3 Select. Copy Object (`x-amz-copy-source`) and Multi-Object Delete
  (`POST ?delete`) are not implemented.
- **Object operations:** GetObjectAttributes (`?attributes`) is not implemented.
  Checksum headers (`x-amz-checksum-*`) and conditional requests (`If-Match`,
  etc.) are not fully supported.
- **List enhancements:** `encoding-type=url`, special delimiter handling,
  ListObjectsV2 `FetchOwner`, unordered listing behavior may not match S3.
- **Auth & IAM:** No IAM policy evaluation, STS, or web identity federation.
  Anonymous access for public buckets/objects is not implemented. Invalid or
  missing SigV4 auth may not return 403/400 as expected.
- **Validation & protocol:** Bucket naming rules (length, format) are not
  strictly enforced. HTTP 100 Continue (`Expect: 100-continue`) is not
  supported. Some error codes and response fields may differ from S3.

For the full list of missing functionality and focus tests (from the s3-tests
suite), see [TODO.md](TODO.md).

## Prior art

- https://github.com/gaul/s3proxy
- https://github.com/ceph/s3-tests
