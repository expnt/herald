import {
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectAttributesCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
  S3ServiceException,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { assertEquals, harness, type ProxyTestCase } from "../utils.ts";
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

interface ChecksumTestSpec {
  name: string;
  fn: (client: S3Client) => Promise<unknown>;
  setup?: (client: S3Client) => Promise<void>;
  teardown?: (client: S3Client) => Promise<void>;
  expectedErrorCode?: string;
}

const BUCKET = "test-checksum-bucket";

const specs: ChecksumTestSpec[] = [
  {
    name: "checksum/put/sha256",
    fn: (c) =>
      c.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: "sha256.txt",
          Body: "hello world",
          ChecksumAlgorithm: "SHA256",
        }),
      ),
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: "sha256.txt" }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "checksum/put/sha1",
    fn: (c) =>
      c.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: "sha1.txt",
          Body: "hello world",
          ChecksumAlgorithm: "SHA1",
        }),
      ),
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: "sha1.txt" }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "checksum/put/crc32c",
    fn: (c) =>
      c.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: "crc32c.txt",
          Body: "hello world",
          ChecksumAlgorithm: "CRC32C",
        }),
      ),
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: "crc32c.txt" }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "checksum/get/existing",
    fn: async (c) => {
      const res = await c.send(
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: "get-checksum.txt",
          ChecksumMode: "ENABLED",
        }),
      );
      // "checksum content" SHA256: nv/y+81/+gPqBBdRZzctlwYpoup/wA77CIGd9Vf5LZc=
      assertEquals(
        res.ChecksumSHA256,
        "nv/y+81/+gPqBBdRZzctlwYpoup/wA77CIGd9Vf5LZc=",
      );
      return res;
    },
    setup: async (c) => {
      await c.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: "get-checksum.txt",
          Body: "checksum content",
          ChecksumAlgorithm: "SHA256",
        }),
      );
    },
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: "get-checksum.txt" }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "checksum/head/existing",
    fn: async (c) => {
      const res = await c.send(
        new HeadObjectCommand({
          Bucket: BUCKET,
          Key: "head-checksum.txt",
          ChecksumMode: "ENABLED",
        }),
      );
      // "head content" CRC32: 0X3UhA==
      assertEquals(res.ChecksumCRC32, "0X3UhA==");
      return res;
    },
    setup: async (c) => {
      await c.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: "head-checksum.txt",
          Body: "head content",
          ChecksumAlgorithm: "CRC32",
        }),
      );
    },
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: "head-checksum.txt" }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "checksum/put/invalid",
    fn: (c) =>
      c.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: "invalid.txt",
          Body: "hello world",
          ChecksumAlgorithm: "SHA256",
          ChecksumSHA256: "bm90IHJlYWxseSBhIGNoZWNrc3VtCg==", // "not really a checksum\n" in base64
        }),
      ),
    expectedErrorCode: "InvalidArgument", // MinIO returns InvalidArgument for malformed base64/length
  },
  {
    name: "checksum/multipart",
    fn: async (c) => {
      const createRes = await c.send(
        new CreateMultipartUploadCommand({
          Bucket: BUCKET,
          Key: "multipart.txt",
          ChecksumAlgorithm: "SHA256",
        }),
      );
      const uploadId = createRes.UploadId;

      await c.send(
        new UploadPartCommand({
          Bucket: BUCKET,
          Key: "multipart.txt",
          UploadId: uploadId,
          PartNumber: 1,
          Body: "part 1 content",
          ChecksumAlgorithm: "SHA256",
        }),
      );
      return;
    },
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: "multipart.txt" }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "checksum/get-attributes",
    fn: async (c) => {
      const res = await c.send(
        new GetObjectAttributesCommand({
          Bucket: BUCKET,
          Key: "attr-checksum.txt",
          ObjectAttributes: ["ETag"],
        }),
      );
      assertEquals(typeof res.ETag, "string");
      return res;
    },
    setup: async (c) => {
      await c.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: "attr-checksum.txt",
          Body: "attr content",
          ChecksumAlgorithm: "SHA256",
        }),
      );
    },
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: "attr-checksum.txt" }),
        );
      } catch { /* ignore */ }
    },
  },
];

const cases: ProxyTestCase[] = specs.map((spec) => ({
  name: spec.name,
  config: testConfig,
  skipSnapshot: true,
  beforeAll: async (c) => {
    try {
      await c.send(new CreateBucketCommand({ Bucket: BUCKET }));
    } catch { /* ignore */ }
  },
  afterAll: async (c) => {
    try {
      await c.send(new DeleteBucketCommand({ Bucket: BUCKET }));
    } catch { /* ignore */ }
  },
  fn: async (c) => {
    if (spec.setup) await spec.setup(c);
    try {
      await spec.fn(c);
      if (spec.expectedErrorCode) {
        throw new Error(
          `Expected error ${spec.expectedErrorCode} but succeeded`,
        );
      }
    } catch (e) {
      if (spec.expectedErrorCode) {
        if (
          e instanceof S3ServiceException && e.name === spec.expectedErrorCode
        ) {
          return;
        }
        if (e instanceof Error && e.message.includes(spec.expectedErrorCode)) {
          return;
        }
        throw new Error(
          `Expected error ${spec.expectedErrorCode} but got ${
            e instanceof Error ? e.name + ": " + e.message : String(e)
          }`,
        );
      }
      throw e;
    } finally {
      if (spec.teardown) await spec.teardown(c);
    }
  },
}));

harness(cases);
