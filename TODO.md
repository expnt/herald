# Missing Functionality in Herald3

This list represents the S3 functionality that is currently missing in Herald3,
based on a comparison with the `s3-tests` suite and a review of the existing
implementation.

## 1. Bucket Operations

- [ ] **Bucket Policies**: Implementation of `GET/PUT/DELETE /?policy`. _(Focus
      tests: `test_get_bucket_policy_status`,
      `test_post_object_missing_policy_condition`)_
- [ ] **CORS (Cross-Origin Resource Sharing)**: Implementation of
      `GET/PUT/DELETE /?cors` and handling of `OPTIONS` preflight requests.
      _(Focus tests: `test_set_cors`, `test_cors_origin_response`,
      `test_cors_header_option`)_
- [ ] **Lifecycle Management**: Implementation of `GET/PUT/DELETE /?lifecycle`.
      _(Focus tests: `test_lifecycle_expiration`, `test_lifecycle_transition`)_
- [ ] **Tagging**: Implementation of `GET/PUT/DELETE /?tagging` for buckets.
      _(Focus tests: `test_bucket_tagging_create`, `test_bucket_tagging_get`)_
- [ ] **Versioning Configuration**: Implementation of `GET/PUT /?versioning`.
      (Basic `listVersions` is partially implemented). _(Focus tests:
      `test_bucket_list_return_data_versioning`,
      `test_versioning_concurrent_multi_object_delete`)_
- [ ] **ACLs (Access Control Lists)**: Implementation of `GET/PUT /?acl` for
      buckets. _(Focus tests: `test_bucket_acl_default`,
      `test_put_bucket_acl_grant_group_read`, `test_bucket_header_acl_grants`)_
- [ ] **Website Configuration**: Implementation of `GET/PUT/DELETE /?website`.
      _(Focus tests: `test_website_configuration`,
      `test_website_error_document`)_
- [ ] **Public Access Block**: Implementation of
      `GET/PUT/DELETE /?publicAccessBlock`. _(Focus tests:
      `test_bucket_public_access_block`)_
- [ ] **Replication Configuration**: Implementation of
      `GET/PUT/DELETE /?replication`.
- [ ] **Notification Configuration (SNS)**: Implementation of
      `GET/PUT /?notification`.
- [ ] **Logging Configuration**: Implementation of `GET/PUT /?logging`. _(Focus
      tests: `test_bucket_logging_config`)_
- [ ] **Inventory Configuration**: Implementation of
      `GET/PUT/DELETE /?inventory`.
- [ ] **Metrics Configuration**: Implementation of `GET/PUT/DELETE /?metrics`.
- [ ] **Intelligent-Tiering Configuration**: Implementation of
      `GET/PUT/DELETE /?intelligent-tiering`.
- [ ] **Ownership Controls**: Implementation of
      `GET/PUT/DELETE /?ownershipControls`.

## 2. Object Operations

- [ ] **Multi-Object Delete**: Implementation of `POST /?delete`. _(Focus tests:
      `test_multi_object_delete`, `test_multi_object_delete_key_limit`)_
- [ ] **Multipart Upload**: Support for `InitiateMultipartUpload`, `UploadPart`,
      `CompleteMultipartUpload`, `AbortMultipartUpload`, and `ListParts`.
      _(Focus tests: `test_multipart_upload`, `test_multipart_upload_empty`,
      `test_abort_multipart_upload`)_
- [ ] **GetObject Attributes**: Implementation of `GET /bucket/key?attributes`.
      _(Focus tests: `test_get_object_attributes`)_
- [ ] **HeadObject Consistency**: Fix `404 Not Found` errors on existing objects
      during certain test sequences. _(Focus tests:
      `test_object_head_zero_bytes`)_
- [ ] **Unicode Metadata**: Fix support for non-ASCII characters in object
      metadata. _(Focus tests: `test_object_set_get_unicode_metadata`)_
- [ ] **Copy Object**: Support for `PUT` with `x-amz-copy-source` header.
      _(Focus tests: `test_object_copy`)_
- [ ] **Tagging**: Implementation of `GET/PUT/DELETE /?tagging` for objects.
      _(Focus tests: `test_object_tagging`)_
- [ ] **ACLs (Access Control Lists)**: Implementation of `GET/PUT /?acl` for
      objects. _(Focus tests: `test_object_acl_default`, `test_object_acl_read`,
      `test_object_put_acl_mtime`)_
- [ ] **Legal Hold & Retention**: Implementation of `GET/PUT /?legal-hold` and
      `GET/PUT /?retention` (Object Lock).
- [ ] **Object Lock Configuration**: Implementation of `GET/PUT /?object-lock`
      on objects.
- [ ] **S3 Select**: Implementation of `POST /?select&select-type=2`.
- [ ] **Checksums**: Support for `x-amz-checksum-sha1`, `x-amz-checksum-sha256`,
      `x-amz-checksum-crc32`, and `x-amz-checksum-crc32c`.
- [ ] **Server-Side Encryption (SSE)**: Handling of
      `x-amz-server-side-encryption`,
      `x-amz-server-side-encryption-customer-algorithm`, etc.
- [ ] **Restore Object**: Support for `POST /?restore`.

## 3. Authentication & IAM

- [ ] **IAM Integration**: Full implementation of IAM policy evaluation for all
      requests.
- [ ] **User Policies**: Support for user-specific IAM policies.
- [ ] **Security Token Service (STS)**: Implementation of `GetSessionToken`,
      `AssumeRole`, etc.
- [ ] **Web Identity Federation**: Implementation of
      `AssumeRoleWithWebIdentity`.

## 4. Validation, Errors & Protocol

- [ ] **Bucket Naming Validation**: Implement strict S3 naming rules (no IP
      addresses, no double dots, length 3-63, etc.). Currently many naming tests
      fail or hang. _(Focus tests: `test_bucket_create_naming_bad_ip`,
      `test_bucket_create_naming_dns_dot_dot`,
      `test_bucket_create_naming_bad_starts_nonalpha`)_
- [ ] **Correct Error Codes**: Ensure accurate HTTP status codes for S3 errors
      (e.g., return `400 Bad Request` or `403 Forbidden` instead of
      `409 Conflict` or `500 Internal Server Error`). _(Focus tests:
      `test_bucket_create_exists`, `test_bucket_create_exists_nonowner`,
      `test_object_read_not_exist`)_
- [ ] **Method POST Support**: Fix "Method POST for key [] not implemented"
      errors at the bucket root level. _(Focus tests:
      `test_multi_object_delete`, `test_post_object_authenticated_request`)_
- [ ] **Multipart Reliability**: Address `502 Bad Gateway` errors occurring
      during `CreateMultipartUpload` and other multipart operations. _(Focus
      tests: `test_multipart_upload`)_
- [ ] **Conditional Requests**: Fix `If-Match`, `If-None-Match`,
      `If-Modified-Since`, and `If-Unmodified-Since` behavior. _(Focus tests:
      `test_get_object_ifmatch_failed`, `test_get_object_ifnonematch_failed`,
      `test_get_object_ifmodifiedsince_failed`)_
- [ ] **Response Field Completeness**: Ensure expected XML/JSON fields like
      `ChecksumSHA256`, `Rules`, `Errors`, and `x-amz-delete-marker` are present
      in responses.
- [ ] **Metadata Handling**: Fix incorrect `BucketAlreadyOwnedByYou` errors
      being returned on non-create operations (e.g., during `PutBucketPolicy`).
      _(Focus tests: `test_bucket_list_return_data`)_

## 5. General Compatibility & Compliance

- [ ] **Strict RFC 2616 Compliance**: Address tests tagged with
      `fails_strict_rfc2616`.
- [ ] **S3Proxy Compatibility**: Address tests tagged with `fails_on_s3proxy` to
      ensure broader compatibility.
- [ ] **Advanced Header Support**: Comprehensive support for headers like
      `Cache-Control`, `Content-Disposition`, `Content-Encoding`,
      `Content-Language`, and `Expires`.

## 5. Non-Standard / Protocol Specific

- [ ] **Append Object**: Implementation of `appendobject` (often found in
      Ceph/RGW).
