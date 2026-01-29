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
- [ ] **Bucket Listing Enhancements**: - [ ] **Encoding Type**: Support for
      `?encoding-type=url` in `ListObjects` and `ListObjectsV2`. _(Focus tests:
      `test_bucket_list_encoding_basic`, `test_bucket_listv2_encoding_basic`)_ -
      [ ] **Special Characters in Delimiters**: Fix handling of percentage,
      whitespace, and other special characters as delimiters. _(Focus tests:
      `test_bucket_list_delimiter_percentage`,
      `test_bucket_list_delimiter_whitespace`)_ - [ ] **V2 Fetch Owner**:
      Support for `FetchOwner` parameter in `ListObjectsV2`. _(Focus tests:
      `test_bucket_listv2_fetchowner_empty`)_ - [ ] **Unordered Listings**:
      Ensure consistent behavior when listing objects in buckets with
      non-standard ordering. _(Focus tests: `test_bucket_list_unordered`)_
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
- [x] **Multipart Upload**: Support for `InitiateMultipartUpload`, `UploadPart`,
      `CompleteMultipartUpload`, `AbortMultipartUpload`, and `ListParts`.
      _(Focus tests: `test_multipart_upload`, `test_multipart_upload_empty`,
      `test_abort_multipart_upload`)_
  - [x] **Swift Multipart Upload**: Implement S3 multipart mapping to Swift SLO.
- [ ] **GetObject Attributes**: Implementation of `GET /bucket/key?attributes`.
      _(Focus tests: `test_get_object_attributes`)_
- [ ] **HeadObject Consistency**: Fix `404 Not Found` errors on existing objects
      during certain test sequences. _(Focus tests:
      `test_object_head_zero_bytes`)_
- [ ] **Unicode Metadata**: Fix support for non-ASCII characters in object
      metadata. Currently failing across all backends. _(Focus tests:
      `test_object_set_get_unicode_metadata`)_
- [ ] **Copy Object**: Support for `PUT` with `x-amz-copy-source` header.
      _(Focus tests: `test_object_copy`)_
- [ ] **Tagging**: Implementation of `GET/PUT/DELETE /?tagging` for objects.
      _(Focus tests: `test_object_tagging`)_
- [ ] **ACLs (Access Control Lists)**: Implementation of `GET/PUT /?acl` for
      objects. Currently failing due to missing XML parsing/formatting for
      object-level ACLs. _(Focus tests: `test_object_acl_default`,
      `test_object_acl_read`, `test_object_put_acl_mtime`)_
- [ ] **Legal Hold & Retention**: Implementation of `GET/PUT /?legal-hold` and
      `GET/PUT /?retention` (Object Lock).
- [ ] **Object Lock Configuration**: Implementation of `GET/PUT /?object-lock`
      on objects.
- [ ] **S3 Select**: Implementation of `POST /?select&select-type=2`.
- [ ] **Checksums**: Support for `x-amz-checksum-sha1`, `x-amz-checksum-sha256`,
      `x-amz-checksum-crc32`, and `x-amz-checksum-crc32c`. Currently failing
      validation tests. _(Focus tests: `test_object_checksum_sha256`)_
  - [ ] **Fix S3 Buffering**: Refactor S3 `putObject` and `uploadPart` to stream
        directly to the AWS SDK instead of collecting chunks into a
        `Uint8Array`.
  - [ ] **Fix Swift Validation Timing**: Move Swift checksum validation before
        the final commit to avoid "zombie" objects (data persisted despite
        failure).
  - [ ] **Implement CRC64NVME**: Add the missing logic for CRC64NVME in the
        `Checksum` service.
  - [ ] **Validation on GET**: Implement "Check-on-Read" validation for `GET`
        requests, supporting abrupt termination or trailers on mismatch.
  - [ ] **Swift Header Cleanup**: Fix duplicate checksum headers in Swift
        responses (remove `x-amz-meta-` versions of internal checksums).
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
- [ ] **Anonymous Access**: Correctly handle anonymous requests for public
      buckets/objects. _(Focus tests: `test_bucket_list_objects_anonymous`,
      `test_post_object_anonymous_request`)_

## 4. Validation, Errors & Protocol

- [ ] **HTTP 100 Continue**: Support for `Expect: 100-continue` (return 100
      before reading body). _(Focus tests: `test_100_continue`,
      `test_100_continue_error_retry`)_
- [ ] **SigV4 Request Validation**: Reject invalid or missing Authorization and
      `x-amz-date` with 403/400. Many tests expect 403 for bad/missing auth.
      _(Focus tests: `test_*_bad_authorization_*`, `test_*_bad_date_*_aws2`)_
- [ ] **Content-Length Handling**: Require or correctly handle Content-Length
      for PUT/POST; reject or accept requests with missing/invalid
      Content-Length as per S3 behavior. _(Focus tests:
      `test_object_create_bad_contentlength_none`,
      `test_bucket_create_bad_contentlength_none`)_
- [ ] **Special Key Names / Prefix**: Bucket create and list with special
      characters in key names and prefix. _(Focus tests:
      `test_bucket_create_special_key_names`,
      `test_bucket_list_special_prefix`)_
- [ ] **Bucket Naming Validation**: Implement strict S3 naming rules (no IP
      addresses, no double dots, length 3-63, etc.). Currently many naming tests
      fail. _(Focus tests: `test_bucket_create_naming_bad_ip`,
      `test_bucket_create_naming_dns_dot_dot`,
      `test_bucket_create_naming_bad_starts_nonalpha`)_
- [ ] **Correct Error Codes**: Ensure accurate HTTP status codes for S3 errors.
      - [ ] **409 Conflict**: Ensure `BucketAlreadyExists` and
      `BucketAlreadyOwnedByYou` return 409. (Partially fixed for Swift create).
      - [ ] **404 Not Found**: Ensure `NoSuchKey` and `NoSuchBucket` return 404
      with correct XML body. - [ ] **403 Forbidden**: Ensure `AccessDenied`
      returns 403.
- [ ] **Method POST Support**: Fix "Method POST for key [] not implemented"
      errors at the bucket root level for authenticated requests. _(Focus tests:
      `test_post_object_authenticated_request`)_
- [ ] **Multipart Reliability**: Address `502 Bad Gateway` errors occurring
      during `CreateMultipartUpload` and other multipart operations. _(Focus
      tests: `test_multipart_upload`)_
- [ ] **Conditional Requests**: Fix `If-Match`, `If-None-Match`,
      `If-Modified-Since`, and `If-Unmodified-Since` behavior. Currently failing
      to return `412 Precondition Failed` or `304 Not Modified` correctly.
      _(Focus tests: `test_get_object_ifmatch_failed`,
      `test_get_object_ifnonematch_good`,
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

## 6. Architectural & DevEx

- [ ] **Configuration Hot-Reloading**: Implement a watcher for `herald.yaml` to
      invalidate the `BackendResolver` cache on configuration changes.
- [ ] **Header Marshalling Abstraction**: Centralize S3 header parsing and
      generation to reduce boilerplate in the Frontend handlers.
