# Herald Helm Chart

Deploy [Herald](https://github.com/expnt/herald) (S3 proxy with backend routing) on Kubernetes.

## Install

```bash
# Install with default values (single replica, config from values)
helm install my-herald ./chart -n herald --create-namespace

# Install with custom config file
helm install my-herald ./chart -n herald --create-namespace -f my-values.yaml
```

## Configuration

| Value | Description | Default |
| ----- | ----------- | ------- |
| `config` | Herald [GlobalConfig](https://github.com/expnt/herald#config): `backends` (required), optional `cors`, `auth`. Rendered as `herald-config.yaml` in a ConfigMap. | `backends: {}` (you must set backends, e.g. S3 or openstack_swift) |
| `port` | App listen port (container port and health probes) | `3000` |
| `image.repository` | Container image | `ghcr.io/expnt/herald` |
| `image.tag` | Image tag | `v0.11.0` |
| `replicaCount` | Number of replicas | `1` |
| `service.port` | Service port | `80` |
| `ingress.enabled` | Create an Ingress | `true` |
| `extraEnv` | Additional env vars (e.g. `HERALD_LOG_LEVEL`, `HERALD_<BACKEND>_*` for backend creds) | `[]` |
| `extraEnvFrom` | Env from Secrets/ConfigMaps | `{}` |
| `resources` | Pod resource requests/limits | `{}` |

Config schema: each backend has `protocol` (`s3` or `swift`), optional `endpoint`, `region`, `credentials`, and `buckets` (`"*"` or a map of bucket names to overrides). See the [main README](../README.md) for full config docs, env vars, auth, and CORS.

## Endpoints

- **Health:** `GET /health` returns `{ "status": "ok" }` (used for liveness/readiness).
- **S3 API:** Path prefix `/s3`. Use `https://<ingress-host>/s3` as the S3 endpoint URL with path-style.
