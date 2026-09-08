# Herald3 — s3-tests Compliance TODO

Measured against the Ceph `s3-tests` suite via
`deno run --allow-all
x/s3-tests.ts --backend <rustfs|swift>` (default tags;
junit per backend in `s3-tests/junit-{rustfs,swift}.xml`).

## Current Scorecard (2026-08-22 full run)

| Backend | Passed | Failed | Notes                                    |
| ------- | -----: | -----: | ---------------------------------------- |
| rustfs  |    254 |    283 | First clean run — zero environment noise |
| swift   |    222 |    315 | SAIO backend                             |

Progression: 146 → 185 (special-keys fix era, MinIO-poisoned numbers) → **254**
on RustFS with the current fix set. The MinIO test backend was removed: its
key-shadowing bug (`foo/bar` hides `foo/bar/xyzzy` from all listings while
blocking DeleteBucket) made clean measurement impossible. RustFS
(`docker.io/rustfs/rustfs:1.0.0-beta.12`) replaced it — same port/creds, correct
nested-key semantics. See `tools/compose.yml` and
`.github/workflows/checks.yml`.

### Recently landed

- [x] XML entity decoding in special-key handling (`&`, `<`, `>`)
- [x] Zero-copy aws-chunked parser (prod O(n²) `appendBytes` stall), decoded
      Content-Length forwarding, client-disconnect mapping
- [x] Subresource dispatch: versioning, ACLs, tagging stubs, CORS, lifecycle…
      (`src/Frontend/Buckets/Subresources.ts`)
- [x] Delimiter / CommonPrefixes / pagination basics
- [x] Bucket + object ACL storage (`.hrld/acl/*` internal namespace)
- [x] Header validation codes (411 MissingContentLength incl. chunked-TE case)
- [x] Conditional requests (If-Match / If-None-Match / If-(Un)Modified-Since)
- [x] Internal-state purge on DeleteBucket (all `RESERVED_INTERNAL_PREFIXES`,
      versions + delete markers)
- [x] ListObjectsV2 `fetch-owner=true` emits `<Owner>` (S3 backend forwards
      `FetchOwner`; Swift backend gates its hardcoded owner on the flag)
- [x] Control-char delimiters/start-after echoed verbatim (`&#xHH;` escaping in
      S3Xml + request-echo in S3 backend; harness query re-encoding fixed)

---

## Next Major Slices

Ordered roughly by value/effort. Counts are rustfs-run failures in each cluster
(many overlap across backends).

### Slice A — ACL grant semantics (~25 fails)

Bucket ACL 13 + object ACL 12. Storage exists; grant parsing/round-trip and
permission evaluation are incomplete. _(Focus:
`test_bucket_acl_canned_during_create`, `test_object_acl_read`,
`test_object_put_acl_mtime`, `test_bucket_header_acl_grants`)_

### Slice B — Anonymous / public access (~12 fails)

Anonymous requests against public-read buckets/objects must be authorized by ACL
instead of denied by default auth policy. Interacts with Slice A. _(Focus:
`test_access_bucket_publicly_accessible`, anonymous list/get/post)_

### Slice C — Bucket naming validation + error codes (~15 fails)

Strict S3 naming rules (IP-like names, length 3–63, leading chars, `..`), plus
accurate status codes/XML bodies for 409/404/403 paths. Swift backend accepts
bad names (SAIO-level gap) — frontend validation makes both consistent. _(Focus:
`test_bucket_create_naming_bad_ip`, `test_bucket_create_naming_bad_*`,
`test_bucket_list_return_data_versioning`)_

### Slice D — PostObject hardening (~13 fails)

Policy condition evaluation (`content-length-range`, key prefix conditions,
success_action_status interplay). Core authenticated flow works (204/200/201).
_(Focus: `test_post_object_set_success_code`,
`test_post_object_missing_expires`,
`test_post_object_conditions_isolate_bucket`)_

### Slice E — CORS preflight & presigned (~10 fails)

`OPTIONS` preflight evaluation against stored CORS rules; presigned-URL CORS
interaction. _(Focus: `test_cors_presigned_get`, `test_cors_origin_response`)_

### Slice F — Versioning edges (~9 fails)

Null-version removal semantics, concurrent create/remove races, version-aware
copy source selection. _(Focus:
`test_versioning_obj_plain_null_version_removal`,
`test_versioned_concurrent_object_create_and_remove`,
`test_versioning_obj_create_read_remove`)_

### Slice G — Multi-object delete edges (~9 fails)

`POST /?delete` quiet mode, error-per-key reporting shape, key limits, versioned
deletes in batch. _(Focus: `test_multi_object_delete_key_limit`,
`test_multi_object_delete_quiet`)_

### Big features (deferred, high effort)

- [ ] **Object Lock** (~36 fails): `?object-lock` configuration, legal-hold,
      retention periods + WORM enforcement. Largest single cluster.
- [ ] **Bucket access logging** (~29 fails): `?logging` get/put/enable cycle +
      log-object delivery. Note: mostly an RGW/Ceph extension; decide whether
      Herald should implement delivery or only config round-trip.
- [ ] **Lifecycle rules**: full rule document parse/store/evaluate.
- [ ] **Tagging** (bucket + object): currently stubbed at dispatch level.
- [ ] **SSE-C / SSE headers**, `?restore`, `?attributes`, S3 Select.
- [ ] **IAM/STS/web-identity**: policy evaluation engine, temp credentials.

### Small fry (known, cheap)

- [ ] `encoding-type=url` in list responses (2 fails, both backends) _(Focus:
      `test_bucket_list{,v2}_encoding_basic`)_
- [ ] Checksum follow-ups: CRC64NVME, GET-time validation, Swift duplicate
      `x-amz-meta-` checksum headers, Swift validate-before-commit (zombies)
- [ ] `Expect: 100-continue` support
- [ ] Unicode metadata round-trip (fails on all backends)
- [ ] `X-RGW-*` usage stats headers (Ceph-only; likely wontfix unless needed)

## Architectural / DevEx

- [ ] Config hot-reload: invalidate `BackendResolver` cache on `herald.yaml`
      change
- [ ] Header marshalling abstraction: centralize S3 header parse/generate
- [ ] Consider upstream RustFS caveat doc: none known so far (unlike MinIO's
      key-shadowing limitation)

## Testing notes

- Unit suite: `deno task test` (373+ green baseline; snapshots under
  `tests/integration/__snapshots__`; volatile headers filtered in
  `tests/utils.ts` sanitizer).
- Backend-tolerance rule: integration specs must accept legitimate backend
  differences (e.g. duplicate CreateBucket → 200 on AWS/RustFS vs 409
  BucketAlreadyOwnedByYou on MinIO/Ceph); use `ignoreBaseline: true` when a
  capability differs (e.g. browser POST uploads unsupported natively by RustFS).
- s3-tests runs: `x/s3-tests.ts --backend rustfs|swift [--no-abort]`.
