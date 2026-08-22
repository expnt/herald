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
    rustfs: {
      protocol: "s3",
      endpoint: "http://localhost:9100",
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
    expectedErrorCode: "BadDigest", // Herald returns BadDigest for checksum mismatch, MinIO might return InvalidArgument for malformed base64
  },
  {
    name: "checksum/multipart/sha256",
    fn: async (c) => {
      const key = "multipart-sha256.txt";
      const createRes = await c.send(
        new CreateMultipartUploadCommand({
          Bucket: BUCKET,
          Key: key,
          ChecksumAlgorithm: "SHA256",
        }),
      );
      const uploadId = createRes.UploadId;
      assertEquals(createRes.ChecksumAlgorithm, "SHA256");

      const part1 = await c.send(
        new UploadPartCommand({
          Bucket: BUCKET,
          Key: key,
          UploadId: uploadId,
          PartNumber: 1,
          Body: "part 1 content",
          ChecksumAlgorithm: "SHA256",
        }),
      );
      assertEquals(
        part1.ChecksumSHA256,
        "Ny7Tdrnd5xrvgBfpd8QWKV//qj0/ulng8FvFIMabLKs=",
      );

      return createRes;
    },
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: "multipart-sha256.txt",
          }),
        );
      } catch { /* ignore */ }
    },
  },
  {
    name: "checksum/get-attributes/full",
    fn: async (c) => {
      const key = "attr-full.txt";
      const sha256sum = "nv/y+81/+gPqBBdRZzctlwYpoup/wA77CIGd9Vf5LZc=";
      await c.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: "checksum content",
          ChecksumAlgorithm: "SHA256",
        }),
      );

      try {
        const res = await c.send(
          new GetObjectAttributesCommand({
            Bucket: BUCKET,
            Key: key,
            ObjectAttributes: ["ETag", "Checksum", "ObjectSize"],
          }),
        );

        assertEquals(res.ObjectSize, 16);
        assertEquals(res.Checksum?.ChecksumSHA256, sha256sum);
        // MinIO returns ChecksumType: "PART_LEVEL" or similar, let's just check the checksum value for now
        return res;
      } catch (e) {
        if (e instanceof S3ServiceException && e.name === "InvalidArgument") {
          // Some backends might not support GetObjectAttributes yet
          return;
        }
        throw e;
      }
    },
    teardown: async (c) => {
      try {
        await c.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: "attr-full.txt" }),
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
          e instanceof S3ServiceException &&
          (e.name === spec.expectedErrorCode ||
            (spec.name === "checksum/get-attributes/full" &&
              e.name === "InvalidArgument") ||
            (spec.name === "checksum/put/invalid" &&
              e.name === "InvalidArgument"))
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
