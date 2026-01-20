# > herald

Herald is an S3 proxy that supports:

- Protocol translation (S3 to S3, S3 to Swift).
- Backend routing based on bucket names.
- Flexible bucket mapping with glob support.

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
    buckets:
      # Simple bucket mapping (inherits backend settings)
      my-bucket: {}

      # Mapping with overrides
      external-data:
        # Map proxy bucket "external-data" to backend bucket "data-v1"
        bucket_name: data-v1
        # Override endpoint for this specific bucket
        endpoint: http://special-endpoint:9000
        # Override region
        region: us-west-2

      # Glob pattern support within the map
      "test-*":
        region: us-east-1
```

### Routing Logic

When a request comes in for a bucket (e.g., `GET /my-bucket/file.txt`), Herald
resolves the backend using the following priority:

1. **Direct match**: Looks for `my-bucket` in all backends' `buckets` maps.
2. **Glob match (map)**: Looks for glob patterns (like `test-*`) in all
   backends' `buckets` maps.
3. **Glob match (string)**: If a backend has `buckets: "..."`, it checks if the
   bucket name matches that pattern.
