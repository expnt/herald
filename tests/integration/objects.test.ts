import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  type S3Client,
  S3ServiceException,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { harness, type ProxyTestCase } from "../utils.ts";
import type { GlobalConfig } from "../../src/Domain/Config.ts";

const testConfig: GlobalConfig = {
  backends: {
    minio: {
      protocol: "s3",
      endpoint: "http://localhost:9000",
      region: "us-east-1",
      credentials: {
        accessKeyId: "minioadmin",
        secretAccessKey: "minioadmin",
      },
      buckets: "*",
    },
  },
};

interface ObjectTestSpec {
  name: string;
  fn: (client: S3Client) => Promise<unknown>;
  setup?: (client: S3Client) => Promise<void>;
  teardown?: (client: S3Client) => Promise<void>;
  expectedErrorCode?: string;
  skipSnapshot?: boolean;
  /** Skip Baseline (already covered by zero-byte-last-part-succeeds). */
  ignoreBaseline?: boolean;
  ignoreSwift?: boolean;
}

const BUCKET = "test-objects-bucket";
const BUCKET_COPY_DIFF = "test-objects-bucket-copy-dest";

const specs: ObjectTestSpec[] = [
  {
    name: "objects/put",
    fn: (c) =>
      c.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: "test.txt",
          Body: "hello world",
        }),
      ),
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: "test.txt" }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "objects/get/existing",
    fn: (c) => c.send(new GetObjectCommand({ Bucket: BUCKET, Key: "get.txt" })),
    setup: async (c) => {
      await c.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: "get.txt",
          Body: "content to get",
        }),
      );
    },
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: "get.txt" }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "objects/get/non-existent",
    fn: (c) => c.send(new GetObjectCommand({ Bucket: BUCKET, Key: "no-such" })),
    expectedErrorCode: "NoSuchKey",
  },
  {
    name: "objects/head/existing",
    fn: (c) =>
      c.send(new HeadObjectCommand({ Bucket: BUCKET, Key: "head.txt" })),
    setup: async (c) => {
      await c.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: "head.txt",
          Body: "content to head",
        }),
      );
    },
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: "head.txt" }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "objects/head/non-existent",
    fn: (c) =>
      c.send(new HeadObjectCommand({ Bucket: BUCKET, Key: "no-such-head" })),
    expectedErrorCode: "NotFound",
  },
  {
    name: "objects/delete/existing",
    fn: (c) =>
      c.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: "delete.txt" })),
    setup: async (c) => {
      await c.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: "delete.txt",
          Body: "content to delete",
        }),
      );
    },
  },
  {
    // Multi-object delete with XML-special keys. Guards against entity-decoding
    // regressions where "&" would be deleted as "&amp;" and survive cleanup,
    // leaving the bucket stuck in BucketNotEmpty state.
    name: "objects/delete/multi-special-keys",
    // The fn performs its own assertions (no leftover keys, bucket deletable);
    // the raw DeleteObjects/List responses are not snapshot-worthy.
    skipSnapshot: true,
    fn: async (c) => {
      const specialKeys = ["&", "<", ">", '"', "'", "a&amp;lt;b"];
      await c.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: {
            Objects: specialKeys.map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      );
      const listed = await c.send(
        new ListObjectsV2Command({ Bucket: BUCKET }),
      );
      const remaining = (listed.Contents ?? []).map((o) => o.Key);
      if (remaining.length > 0) {
        throw new Error(
          `special keys survived multi-delete: ${JSON.stringify(remaining)}`,
        );
      }
      // Prove the bucket is empty enough to delete (s3-tests fixture cleanup path).
      await c.send(new DeleteBucketCommand({ Bucket: BUCKET }));
    },
    setup: async (c) => {
      await Promise.all(
        ["&", "<", ">", '"', "'", "a&amp;lt;b"].map((Key) =>
          c.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body: "x" }))
        ),
      );
    },
  },
  {
    name: "objects/multipart/basic",
    fn: async (c) => {
      const key = "multipart-basic.txt";
      const { UploadId } = await c.send(
        new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key }),
      );
      if (!UploadId) throw new Error("No UploadId");

      const partSize = 5 * 1024 * 1024 + 1;
      const body1 = new Uint8Array(partSize).fill(97); // 'a'
      const body2 = new Uint8Array(10).fill(98); // 'b'

      const { ETag: etag1 } = await c.send(
        new UploadPartCommand({
          Bucket: BUCKET,
          Key: key,
          UploadId,
          PartNumber: 1,
          Body: body1,
        }),
      );
      const { ETag: etag2 } = await c.send(
        new UploadPartCommand({
          Bucket: BUCKET,
          Key: key,
          UploadId,
          PartNumber: 2,
          Body: body2,
        }),
      );

      await c.send(
        new CompleteMultipartUploadCommand({
          Bucket: BUCKET,
          Key: key,
          UploadId,
          MultipartUpload: {
            Parts: [
              { ETag: etag1, PartNumber: 1 },
              { ETag: etag2, PartNumber: 2 },
            ],
          },
        }),
      );

      const { ContentLength } = await c.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: key }),
      );
      if (ContentLength !== partSize + 10) {
        throw new Error(
          `Size mismatch: expected ${partSize + 10}, got ${ContentLength}`,
        );
      }
    },
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: "multipart-basic.txt",
          }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "objects/multipart/abort",
    fn: async (c) => {
      const key = "multipart-abort.txt";
      const { UploadId } = await c.send(
        new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key }),
      );
      if (!UploadId) throw new Error("No UploadId");

      await c.send(
        new UploadPartCommand({
          Bucket: BUCKET,
          Key: key,
          UploadId,
          PartNumber: 1,
          Body: "part 1",
        }),
      );

      await c.send(
        new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: key, UploadId }),
      );

      try {
        await c.send(
          new ListPartsCommand({ Bucket: BUCKET, Key: key, UploadId }),
        );
        throw new Error("ListParts should have failed after Abort");
      } catch (e) {
        if (!(e instanceof S3ServiceException && e.name === "NoSuchUpload")) {
          throw e;
        }
      }
    },
  },
  {
    name: "objects/multipart/list-parts",
    fn: async (c) => {
      const key = "multipart-list.txt";
      const { UploadId } = await c.send(
        new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key }),
      );
      if (!UploadId) throw new Error("No UploadId");

      await c.send(
        new UploadPartCommand({
          Bucket: BUCKET,
          Key: key,
          UploadId,
          PartNumber: 1,
          Body: "part 1",
        }),
      );

      const { Parts } = await c.send(
        new ListPartsCommand({ Bucket: BUCKET, Key: key, UploadId }),
      );

      if (!Parts || Parts.length !== 1 || Parts[0].PartNumber !== 1) {
        throw new Error(`Unexpected parts list: ${JSON.stringify(Parts)}`);
      }

      await c.send(
        new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: key, UploadId }),
      );
    },
  },
  {
    name: "objects/multipart/empty",
    fn: async (c) => {
      const key = "multipart-empty.txt";
      const { UploadId } = await c.send(
        new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key }),
      );
      if (!UploadId) throw new Error("No UploadId");

      try {
        await c.send(
          new CompleteMultipartUploadCommand({
            Bucket: BUCKET,
            Key: key,
            UploadId,
            MultipartUpload: { Parts: [] },
          }),
        );
        throw new Error("Complete should have failed for empty parts");
      } catch (e) {
        if (
          e instanceof S3ServiceException &&
          (e.name === "MalformedXML" || e.name === "InvalidPart" ||
            e.name === "InvalidRequest")
        ) {
          return;
        }
        throw e;
      } finally {
        try {
          await c.send(
            new AbortMultipartUploadCommand({
              Bucket: BUCKET,
              Key: key,
              UploadId,
            }),
          );
        } catch { /* ignore */ }
      }
    },
  },
  // S3 spec: last part has no minimum size (can be 0 bytes). So 0-byte part + complete succeeds for all backends.
  {
    name: "objects/multipart/zero-byte-last-part-succeeds",
    fn: async (c) => {
      const key = "multipart-zero-last-part.txt";
      const { UploadId } = await c.send(
        new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key }),
      );
      if (!UploadId) throw new Error("No UploadId");

      const { ETag } = await c.send(
        new UploadPartCommand({
          Bucket: BUCKET,
          Key: key,
          UploadId,
          PartNumber: 1,
          Body: new Uint8Array(0),
        }),
      );
      if (!ETag) throw new Error("No ETag");

      await c.send(
        new CompleteMultipartUploadCommand({
          Bucket: BUCKET,
          Key: key,
          UploadId,
          MultipartUpload: { Parts: [{ PartNumber: 1, ETag }] },
        }),
      );

      const { ContentLength } = await c.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: key }),
      );
      if (ContentLength !== 0) {
        throw new Error(`Expected size 0, got ${ContentLength}`);
      }
    },
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: "multipart-zero-last-part.txt",
          }),
        );
      } catch { /* ignore */ }
    },
    skipSnapshot: true,
  },
  // S3 allows a 0-byte final part; the Swift backend completes it as a plain empty object.
  {
    name: "objects/multipart/zero-byte-part-complete",
    fn: async (c) => {
      const key = "multipart-zero-part-complete.txt";
      const { UploadId } = await c.send(
        new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key }),
      );
      if (!UploadId) throw new Error("No UploadId");

      const { ETag } = await c.send(
        new UploadPartCommand({
          Bucket: BUCKET,
          Key: key,
          UploadId,
          PartNumber: 1,
          Body: new Uint8Array(0),
        }),
      );
      if (!ETag) throw new Error("No ETag");

      await c.send(
        new CompleteMultipartUploadCommand({
          Bucket: BUCKET,
          Key: key,
          UploadId,
          MultipartUpload: { Parts: [{ PartNumber: 1, ETag }] },
        }),
      );

      const { ContentLength } = await c.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: key }),
      );
      if (ContentLength !== 0) {
        throw new Error(`Expected size 0, got ${ContentLength}`);
      }
    },
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: "multipart-zero-part-complete.txt",
          }),
        );
      } catch { /* ignore */ }
    },
    skipSnapshot: true,
    ignoreBaseline: true,
  },
  // CopyObject: same bucket
  {
    name: "objects/copy/same_bucket",
    fn: async (c) => {
      const srcKey = "copy-src-key";
      const destKey = "copy-dest-key";
      await c.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: srcKey,
          Body: "content to copy",
        }),
      );
      await c.send(
        new CopyObjectCommand({
          Bucket: BUCKET,
          Key: destKey,
          CopySource: `${BUCKET}/${srcKey}`,
        }),
      );
      const out = await c.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: destKey }),
      );
      const body = await out.Body?.transformToByteArray();
      if (!body || new TextDecoder().decode(body) !== "content to copy") {
        throw new Error(
          `Copy body mismatch: expected "content to copy", got ${
            body ? new TextDecoder().decode(body) : "null"
          }`,
        );
      }
    },
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: "copy-src-key" }),
        );
        await c.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: "copy-dest-key" }),
        );
      } catch { /* ignore */ }
    },
  },
  // CopyObject: zero size
  {
    name: "objects/copy/zero_size",
    fn: async (c) => {
      const srcKey = "copy-zero-src";
      const destKey = "copy-zero-dest";
      await c.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: srcKey,
          Body: new Uint8Array(0),
        }),
      );
      await c.send(
        new CopyObjectCommand({
          Bucket: BUCKET,
          Key: destKey,
          CopySource: `${BUCKET}/${srcKey}`,
        }),
      );
      const head = await c.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: destKey }),
      );
      if (head.ContentLength !== 0) {
        throw new Error(
          `Expected ContentLength 0, got ${head.ContentLength}`,
        );
      }
    },
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: "copy-zero-src" }),
        );
        await c.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: "copy-zero-dest" }),
        );
      } catch { /* ignore */ }
    },
  },
  // CopyObject: copy to self -> 400 InvalidRequest
  {
    name: "objects/copy/copy_to_itself",
    fn: async (c) => {
      const key = "copy-self-key";
      await c.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "x" }),
      );
      try {
        await c.send(
          new CopyObjectCommand({
            Bucket: BUCKET,
            Key: key,
            CopySource: `${BUCKET}/${key}`,
          }),
        );
        throw new Error("Expected CopyObject to self to fail with 400");
      } catch (e) {
        if (
          e instanceof S3ServiceException &&
          e.name === "InvalidRequest" &&
          e.$metadata?.httpStatusCode === 400
        ) {
          return;
        }
        throw e;
      } finally {
        try {
          await c.send(
            new DeleteObjectCommand({ Bucket: BUCKET, Key: key }),
          );
        } catch { /* ignore */ }
      }
    },
  },
  // CopyObject: source key not found -> 404 NoSuchKey
  {
    name: "objects/copy/source_key_not_found",
    fn: (c) =>
      c.send(
        new CopyObjectCommand({
          Bucket: BUCKET,
          Key: "copy-dest-any",
          CopySource: `${BUCKET}/no-such-source-key`,
        }),
      ),
    expectedErrorCode: "NoSuchKey",
  },
  // CopyObject: source bucket not found -> 404 (NoSuchBucket or backend 404)
  {
    name: "objects/copy/source_bucket_not_found",
    fn: async (c) => {
      try {
        await c.send(
          new CopyObjectCommand({
            Bucket: BUCKET,
            Key: "copy-dest-any",
            CopySource: "nonexistent-bucket-xyz-123/any-key",
          }),
        );
        throw new Error("Expected CopyObject to fail with 404");
      } catch (e) {
        if (e instanceof S3ServiceException) {
          if (e.$metadata?.httpStatusCode !== 404) {
            throw new Error(
              `Expected 404, got ${e.$metadata?.httpStatusCode} (${e.name})`,
            );
          }
          return;
        }
        throw e;
      }
    },
  },
  // CopyObject: different bucket (same backend)
  {
    name: "objects/copy/diff_bucket",
    fn: async (c) => {
      const srcKey = "copy-diff-src";
      const destKey = "copy-diff-dest";
      await c.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: srcKey,
          Body: "foo from A",
        }),
      );
      await c.send(
        new CopyObjectCommand({
          Bucket: BUCKET_COPY_DIFF,
          Key: destKey,
          CopySource: `${BUCKET}/${srcKey}`,
        }),
      );
      const out = await c.send(
        new GetObjectCommand({
          Bucket: BUCKET_COPY_DIFF,
          Key: destKey,
        }),
      );
      const body = await out.Body?.transformToByteArray();
      if (!body || new TextDecoder().decode(body) !== "foo from A") {
        throw new Error(
          `Copy diff_bucket body mismatch: got ${
            body ? new TextDecoder().decode(body) : "null"
          }`,
        );
      }
    },
    setup: async (c) => {
      try {
        await c.send(new CreateBucketCommand({ Bucket: BUCKET_COPY_DIFF }));
      } catch { /* ignore if exists */ }
    },
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: "copy-diff-src" }),
        );
        await c.send(
          new DeleteObjectCommand({
            Bucket: BUCKET_COPY_DIFF,
            Key: "copy-diff-dest",
          }),
        );
        await c.send(
          new DeleteBucketCommand({ Bucket: BUCKET_COPY_DIFF }),
        );
      } catch { /* ignore */ }
    },
  },
  // CopyObject: verify Content-Type preserved (metadata COPY).
  {
    name: "objects/copy/verify_content_type",
    fn: async (c) => {
      const srcKey = "copy-ct-src";
      const destKey = "copy-ct-dest";
      const contentType = "application/x-custom-test";
      await c.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: srcKey,
          Body: "data",
          ContentType: contentType,
        }),
      );
      await c.send(
        new CopyObjectCommand({
          Bucket: BUCKET,
          Key: destKey,
          CopySource: `${BUCKET}/${srcKey}`,
        }),
      );
      const head = await c.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: destKey }),
      );
      if (head.ContentType !== contentType) {
        throw new Error(
          `Expected Content-Type ${contentType}, got ${head.ContentType}`,
        );
      }
    },
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: "copy-ct-src" }),
        );
        await c.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: "copy-ct-dest" }),
        );
      } catch { /* ignore */ }
    },
  },
  // CopyObject: replace metadata
  {
    name: "objects/copy/replace_metadata",
    fn: async (c) => {
      const srcKey = "copy-replace-src";
      const destKey = "copy-replace-dest";
      await c.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: srcKey,
          Body: "data",
          Metadata: { "old-meta": "old-value" },
        }),
      );
      await c.send(
        new CopyObjectCommand({
          Bucket: BUCKET,
          Key: destKey,
          CopySource: `${BUCKET}/${srcKey}`,
          MetadataDirective: "REPLACE",
          Metadata: { "new-meta": "new-value" },
        }),
      );
      const head = await c.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: destKey }),
      );
      if (head.Metadata?.["new-meta"] !== "new-value") {
        throw new Error(
          `Expected new-meta: new-value, got ${head.Metadata?.["new-meta"]}`,
        );
      }
      if (head.Metadata?.["old-meta"]) {
        throw new Error("old-meta should have been replaced");
      }
    },
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: "copy-replace-src" }),
        );
        await c.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: "copy-replace-dest" }),
        );
      } catch { /* ignore */ }
    },
  },
  // ---- Conditional requests (RFC 7232) ----
  {
    name: "objects/conditional/get_ifmatch_failed",
    fn: async (c) => {
      const key = "cond-get-ifmatch-fail";
      await c.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "bar" }),
      );
      try {
        await c.send(
          new GetObjectCommand({
            Bucket: BUCKET,
            Key: key,
            IfMatch: '"ABCORZ"',
          }),
        );
        throw new Error("Expected 412 PreconditionFailed");
      } catch (e) {
        if (
          !(e instanceof S3ServiceException) || e.name !== "PreconditionFailed"
        ) {
          throw new Error(
            `Expected PreconditionFailed, got ${
              (e as { name?: string }).name
            }: ${(e as { message?: string }).message}`,
          );
        }
      }
    },
    skipSnapshot: true,
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: "cond-get-ifmatch-fail",
          }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "objects/conditional/get_ifmatch_good",
    fn: async (c) => {
      const key = "cond-get-ifmatch-good";
      await c.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "bar" }),
      );
      const head = await c.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: key }),
      );
      const res = await c.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: key, IfMatch: head.ETag }),
      );
      const body = await res.Body?.transformToString();
      if (body !== "bar") {
        throw new Error(`Expected body 'bar', got '${body}'`);
      }
    },
    skipSnapshot: true,
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: "cond-get-ifmatch-good",
          }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "objects/conditional/get_ifnonematch_304",
    fn: async (c) => {
      const key = "cond-get-ifnonematch-304";
      await c.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "bar" }),
      );
      const head = await c.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: key }),
      );
      try {
        await c.send(
          new GetObjectCommand({
            Bucket: BUCKET,
            Key: key,
            IfNoneMatch: head.ETag,
          }),
        );
        throw new Error("Expected 304 Not Modified");
      } catch (e) {
        const status = (e as { $metadata?: { httpStatusCode?: number } })
          .$metadata
          ?.httpStatusCode;
        if (status !== 304) {
          throw new Error(
            `Expected 304, got ${status}: ${
              (e as { message?: string }).message
            }`,
          );
        }
        const etagHeader =
          (e as { $response?: { headers?: Record<string, string> } })
            .$response?.headers?.etag;
        if (etagHeader !== head.ETag) {
          throw new Error(
            `Expected ETag header ${head.ETag}, got ${etagHeader}`,
          );
        }
      }
    },
    skipSnapshot: true,
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: "cond-get-ifnonematch-304",
          }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "objects/conditional/get_ifnonematch_good",
    fn: async (c) => {
      const key = "cond-get-ifnonematch-good";
      await c.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "bar" }),
      );
      const res = await c.send(
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: key,
          IfNoneMatch: '"ABCORZ"',
        }),
      );
      const body = await res.Body?.transformToString();
      if (body !== "bar") {
        throw new Error(`Expected body 'bar', got '${body}'`);
      }
    },
    skipSnapshot: true,
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: "cond-get-ifnonematch-good",
          }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "objects/conditional/get_ifmodifiedsince_304",
    fn: async (c) => {
      const key = "cond-get-ifmodifiedsince-304";
      await c.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "bar" }),
      );
      try {
        await c.send(
          new GetObjectCommand({
            Bucket: BUCKET,
            Key: key,
            IfModifiedSince: new Date("2100-01-01T00:00:00Z"),
          }),
        );
        throw new Error("Expected 304 Not Modified");
      } catch (e) {
        const status = (e as { $metadata?: { httpStatusCode?: number } })
          .$metadata
          ?.httpStatusCode;
        if (status !== 304) {
          throw new Error(
            `Expected 304, got ${status}: ${
              (e as { message?: string }).message
            }`,
          );
        }
      }
    },
    skipSnapshot: true,
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: "cond-get-ifmodifiedsince-304",
          }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "objects/conditional/get_ifmodifiedsince_good",
    fn: async (c) => {
      const key = "cond-get-ifmodifiedsince-good";
      await c.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "bar" }),
      );
      const res = await c.send(
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: key,
          IfModifiedSince: new Date("1994-10-29T19:43:31Z"),
        }),
      );
      const body = await res.Body?.transformToString();
      if (body !== "bar") {
        throw new Error(`Expected body 'bar', got '${body}'`);
      }
    },
    skipSnapshot: true,
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: "cond-get-ifmodifiedsince-good",
          }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "objects/conditional/get_ifunmodifiedsince_412",
    fn: async (c) => {
      const key = "cond-get-ifunmodifiedsince-412";
      await c.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "bar" }),
      );
      try {
        await c.send(
          new GetObjectCommand({
            Bucket: BUCKET,
            Key: key,
            IfUnmodifiedSince: new Date("1994-10-29T19:43:31Z"),
          }),
        );
        throw new Error("Expected 412 PreconditionFailed");
      } catch (e) {
        if (
          !(e instanceof S3ServiceException) || e.name !== "PreconditionFailed"
        ) {
          throw new Error(
            `Expected PreconditionFailed, got ${
              (e as { name?: string }).name
            }: ${(e as { message?: string }).message}`,
          );
        }
      }
    },
    skipSnapshot: true,
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: "cond-get-ifunmodifiedsince-412",
          }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "objects/conditional/get_ifunmodifiedsince_good",
    fn: async (c) => {
      const key = "cond-get-ifunmodifiedsince-good";
      await c.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "bar" }),
      );
      const res = await c.send(
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: key,
          IfUnmodifiedSince: new Date("2100-01-01T00:00:00Z"),
        }),
      );
      const body = await res.Body?.transformToString();
      if (body !== "bar") {
        throw new Error(`Expected body 'bar', got '${body}'`);
      }
    },
    skipSnapshot: true,
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: "cond-get-ifunmodifiedsince-good",
          }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "objects/conditional/put_ifmatch_failed",
    fn: async (c) => {
      const key = "cond-put-ifmatch-fail";
      await c.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "bar" }),
      );
      try {
        await c.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            Body: "zar",
            IfMatch: '"ABCORZ"',
          }),
        );
        throw new Error("Expected 412 PreconditionFailed");
      } catch (e) {
        if (
          !(e instanceof S3ServiceException) || e.name !== "PreconditionFailed"
        ) {
          throw new Error(
            `Expected PreconditionFailed, got ${
              (e as { name?: string }).name
            }: ${(e as { message?: string }).message}`,
          );
        }
      }
      // Original content must be untouched.
      const res = await c.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: key }),
      );
      const body = await res.Body?.transformToString();
      if (body !== "bar") {
        throw new Error(`Expected body 'bar' after failed PUT, got '${body}'`);
      }
    },
    skipSnapshot: true,
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: "cond-put-ifmatch-fail",
          }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "objects/conditional/put_ifmatch_good",
    fn: async (c) => {
      const key = "cond-put-ifmatch-good";
      await c.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "bar" }),
      );
      const head = await c.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: key }),
      );
      await c.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: "zar",
          IfMatch: head.ETag,
        }),
      );
      const res = await c.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: key }),
      );
      const body = await res.Body?.transformToString();
      if (body !== "zar") {
        throw new Error(
          `Expected body 'zar' after matching PUT, got '${body}'`,
        );
      }
    },
    skipSnapshot: true,
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: "cond-put-ifmatch-good",
          }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "objects/conditional/put_ifmatch_nonexistent",
    fn: async (c) => {
      const key = "cond-put-ifmatch-nonexistent";
      try {
        await c.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            Body: "bar",
            IfMatch: "*",
          }),
        );
        throw new Error("Expected 404 NoSuchKey");
      } catch (e) {
        if (!(e instanceof S3ServiceException) || e.name !== "NoSuchKey") {
          throw new Error(
            `Expected NoSuchKey, got ${(e as { name?: string }).name}: ${
              (e as { message?: string }).message
            }`,
          );
        }
      }
    },
    skipSnapshot: true,
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: "cond-put-ifmatch-nonexistent",
          }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "objects/conditional/put_ifnonematch_failed",
    fn: async (c) => {
      const key = "cond-put-ifnonematch-fail";
      await c.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "bar" }),
      );
      const head = await c.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: key }),
      );
      try {
        await c.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            Body: "zar",
            IfNoneMatch: head.ETag,
          }),
        );
        throw new Error("Expected 412 PreconditionFailed");
      } catch (e) {
        if (
          !(e instanceof S3ServiceException) || e.name !== "PreconditionFailed"
        ) {
          throw new Error(
            `Expected PreconditionFailed, got ${
              (e as { name?: string }).name
            }: ${(e as { message?: string }).message}`,
          );
        }
      }
    },
    skipSnapshot: true,
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: "cond-put-ifnonematch-fail",
          }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "objects/conditional/put_ifnonematch_good",
    fn: async (c) => {
      const key = "cond-put-ifnonematch-good";
      await c.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "bar" }),
      );
      await c.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: "zar",
          IfNoneMatch: '"ABCORZ"',
        }),
      );
      const res = await c.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: key }),
      );
      const body = await res.Body?.transformToString();
      if (body !== "zar") {
        throw new Error(
          `Expected body 'zar' after non-matching PUT, got '${body}'`,
        );
      }
    },
    skipSnapshot: true,
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: "cond-put-ifnonematch-good",
          }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "objects/conditional/put_ifnonematch_nonexistent_good",
    fn: async (c) => {
      const key = "cond-put-ifnonematch-nonexistent";
      await c.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: "bar",
          IfNoneMatch: "*",
        }),
      );
      const res = await c.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: key }),
      );
      const body = await res.Body?.transformToString();
      if (body !== "bar") {
        throw new Error(`Expected body 'bar', got '${body}'`);
      }
    },
    skipSnapshot: true,
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: "cond-put-ifnonematch-nonexistent",
          }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "objects/conditional/delete_ifmatch_failed",
    fn: async (c) => {
      const key = "cond-delete-ifmatch-fail";
      await c.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "bar" }),
      );
      try {
        await c.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: key,
            IfMatch: '"badetag"',
          }),
        );
        throw new Error("Expected 412 PreconditionFailed");
      } catch (e) {
        if (
          !(e instanceof S3ServiceException) || e.name !== "PreconditionFailed"
        ) {
          throw new Error(
            `Expected PreconditionFailed, got ${
              (e as { name?: string }).name
            }: ${(e as { message?: string }).message}`,
          );
        }
      }
      // Object must still exist.
      await c.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    },
    skipSnapshot: true,
    ignoreBaseline: true, // MinIO does not enforce If-Match on DeleteObject
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: "cond-delete-ifmatch-fail",
          }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "objects/conditional/delete_ifmatch_good",
    fn: async (c) => {
      const key = "cond-delete-ifmatch-good";
      const etag = (await c.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "bar" }),
      )).ETag;
      await c.send(
        new DeleteObjectCommand({ Bucket: BUCKET, Key: key, IfMatch: etag }),
      );
      try {
        await c.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
        throw new Error("Expected object to be deleted");
      } catch (e) {
        if (!(e instanceof S3ServiceException) || e.name !== "NotFound") {
          throw new Error(
            `Expected NotFound after delete, got ${
              (e as { name?: string }).name
            }: ${(e as { message?: string }).message}`,
          );
        }
      }
    },
    skipSnapshot: true,
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: "cond-delete-ifmatch-good",
          }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "objects/conditional/delete_ifmatch_nonexistent",
    fn: async (c) => {
      const key = "cond-delete-ifmatch-nonexistent";
      // Deleting a non-existent object with If-Match is an idempotent 204.
      await c.send(
        new DeleteObjectCommand({ Bucket: BUCKET, Key: key, IfMatch: "*" }),
      );
      await c.send(
        new DeleteObjectCommand({
          Bucket: BUCKET,
          Key: key,
          IfMatch: '"badetag"',
        }),
      );
    },
    skipSnapshot: true,
    ignoreBaseline: true, // MinIO does not enforce If-Match on DeleteObject
  },
  {
    name: "objects/conditional/precedence_ifmatch_over_ifunmodified",
    fn: async (c) => {
      const key = "cond-precedence-1";
      await c.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "bar" }),
      );
      const head = await c.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: key }),
      );
      const before = new Date((head.LastModified?.getTime() ?? 0) - 1000);
      // If-Match true overrides a failing If-Unmodified-Since (RFC 7232 §6).
      const res = await c.send(
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: key,
          IfMatch: head.ETag,
          IfUnmodifiedSince: before,
        }),
      );
      const body = await res.Body?.transformToString();
      if (body !== "bar") {
        throw new Error(`Expected body 'bar', got '${body}'`);
      }
    },
    skipSnapshot: true,
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: "cond-precedence-1" }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "objects/conditional/precedence_ifnonematch_over_ifmodified",
    fn: async (c) => {
      const key = "cond-precedence-2";
      await c.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "bar" }),
      );
      const head = await c.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: key }),
      );
      // If-None-Match match wins over a failing If-Modified-Since (RFC 7232 §6).
      try {
        await c.send(
          new GetObjectCommand({
            Bucket: BUCKET,
            Key: key,
            IfNoneMatch: head.ETag,
            IfModifiedSince: new Date("1994-10-29T19:43:31Z"),
          }),
        );
        throw new Error("Expected 304 Not Modified");
      } catch (e) {
        const status = (e as { $metadata?: { httpStatusCode?: number } })
          .$metadata
          ?.httpStatusCode;
        if (status !== 304) {
          throw new Error(
            `Expected 304, got ${status}: ${
              (e as { message?: string }).message
            }`,
          );
        }
      }
    },
    skipSnapshot: true,
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: "cond-precedence-2" }),
        );
      } catch { /* ignore */ }
    },
  },
];

async function runObjectTest(tc: ObjectTestSpec, client: S3Client) {
  try {
    await tc.setup?.(client);

    try {
      await tc.fn(client);
      if (tc.expectedErrorCode) {
        throw new Error(
          `Expected error code ${tc.expectedErrorCode} but command succeeded for ${tc.name}`,
        );
      }
    } catch (e: unknown) {
      if (e instanceof S3ServiceException) {
        if (tc.expectedErrorCode) {
          if (e.name !== tc.expectedErrorCode) {
            throw new Error(
              `Error code mismatch for ${tc.name}: expected ${tc.expectedErrorCode}, got ${e.name}`,
            );
          }
        } else {
          throw e;
        }
      } else {
        throw e;
      }
    }
  } finally {
    await tc.teardown?.(client);
  }
}

const cases: ProxyTestCase[] = specs.map((spec) => ({
  name: spec.name,
  config: testConfig,
  beforeAll: async (client: S3Client) => {
    try {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    } catch { /* ignore if already exists */ }
  },
  afterAll: async (client: S3Client) => {
    try {
      await client.send(new DeleteBucketCommand({ Bucket: BUCKET }));
    } catch { /* ignore */ }
  },
  fn: (client: S3Client) => runObjectTest(spec, client),
  skipSnapshot: spec.skipSnapshot,
  ignoreBaseline: spec.ignoreBaseline,
  ignoreSwift: spec.ignoreSwift,
}));

harness(cases);
