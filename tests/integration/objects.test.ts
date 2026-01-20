import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
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
}

const BUCKET = "test-objects-bucket";

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
}));

harness(cases);
