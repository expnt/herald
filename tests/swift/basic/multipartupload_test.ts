import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "aws-sdk/client-s3";
import { assert, assertEquals } from "std/assert";
import { loggingMiddleware, testConfig } from "../../utils/mod.ts";
import { proxyUrl } from "../../../src/config/mod.ts";
import { deleteBucketIfExists } from "../../../utils/s3.ts";

const containerName = "swift-test";
const objectKey = "test-object.txt";
const multipartIndexPath = ".herald-state/multipart-uploads/index.json";

const s3 = new S3Client({
  ...testConfig,
  endpoint: proxyUrl,
});
s3.middlewareStack.add(loggingMiddleware, {
  step: "finalizeRequest",
});

Deno.test("Multipart Upload Flow", async (t) => {
  await t.step("Cleanup bucket if exists", async () => {
    await deleteBucketIfExists(s3, containerName);
  });

  await t.step("Create Bucket", async () => {
    const result = await s3.send(
      new CreateBucketCommand({
        Bucket: containerName,
      }),
    );
    assertEquals(result.$metadata.httpStatusCode, 200);

    // Create empty index.json file for multipart uploads
    const createIndexResult = await s3.send(
      new PutObjectCommand({
        Bucket: containerName,
        Key: multipartIndexPath,
        Body: JSON.stringify({
          lastUpdated: new Date().toISOString(),
          uploads: [],
        }),
        ContentType: "application/json",
      }),
    );
    assertEquals(createIndexResult.$metadata.httpStatusCode, 200);
  });

  let uploadId = "";

  await t.step("Initiate Multipart Upload", async () => {
    const result = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: containerName,
        Key: objectKey,
      }),
    );

    assert(result.UploadId);
    uploadId = result.UploadId!;
    assertEquals(result.Key, objectKey);
  });

  let partETag = "";

  await t.step("Upload Part 1", async () => {
    const result = await s3.send(
      new UploadPartCommand({
        Bucket: containerName,
        Key: objectKey,
        PartNumber: 1,
        UploadId: uploadId,
        Body: new TextEncoder().encode("Hello multipart world!"),
      }),
    );

    assert(result.ETag);
    partETag = result.ETag!;
  });

  await t.step("List Parts", async () => {
    const result = await s3.send(
      new ListPartsCommand({
        Bucket: containerName,
        Key: objectKey,
        UploadId: uploadId,
      }),
    );

    assertEquals(result.Parts?.length, 1);
    assertEquals(result.Parts?.[0].PartNumber, 1);
    assertEquals(result.Parts?.[0].ETag, partETag);
  });

  await t.step("List Multipart Uploads", async () => {
    const result = await s3.send(
      new ListMultipartUploadsCommand({
        Bucket: containerName,
      }),
    );

    assert(result.Uploads?.find((u) => u.UploadId === uploadId));
  });

  await t.step("Complete Multipart Upload", async () => {
    const result = await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: containerName,
        Key: objectKey,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [
            {
              PartNumber: 1,
              ETag: partETag,
            },
          ],
        },
      }),
    );

    assertEquals(result.Key, objectKey);
  });

  await t.step("Cleanup Bucket", async () => {
    await deleteBucketIfExists(s3, containerName);
  });
});

Deno.test("Abort Multipart Upload Flow", async (t) => {
  await t.step("Cleanup bucket if exists", async () => {
    await deleteBucketIfExists(s3, containerName);
  });

  await t.step("Create Bucket", async () => {
    const result = await s3.send(
      new CreateBucketCommand({
        Bucket: containerName,
      }),
    );
    assertEquals(result.$metadata.httpStatusCode, 200);

    // Create empty index.json file for multipart uploads
    const createIndexResult = await s3.send(
      new PutObjectCommand({
        Bucket: containerName,
        Key: multipartIndexPath,
        Body: JSON.stringify({
          lastUpdated: new Date().toISOString(),
          uploads: [],
        }),
        ContentType: "application/json",
      }),
    );
    assertEquals(createIndexResult.$metadata.httpStatusCode, 200);
  });

  let uploadId = "";

  await t.step("Initiate Multipart Upload", async () => {
    const result = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: containerName,
        Key: objectKey,
      }),
    );

    assert(result.UploadId);
    uploadId = result.UploadId!;
    assertEquals(result.Key, objectKey);
  });

  await t.step("Upload Part 1", async () => {
    const result = await s3.send(
      new UploadPartCommand({
        Bucket: containerName,
        Key: objectKey,
        PartNumber: 1,
        UploadId: uploadId,
        Body: new TextEncoder().encode("Hello multipart world!"),
      }),
    );

    assert(result.ETag);
  });

  await t.step("Verify Upload Exists", async () => {
    const result = await s3.send(
      new ListMultipartUploadsCommand({
        Bucket: containerName,
      }),
    );

    assert(result.Uploads?.find((u) => u.UploadId === uploadId));
  });

  await t.step("Abort Multipart Upload", async () => {
    const result = await s3.send(
      new AbortMultipartUploadCommand({
        Bucket: containerName,
        Key: objectKey,
        UploadId: uploadId,
      }),
    );

    assertEquals(result.$metadata.httpStatusCode, 204);
  });

  await t.step("Verify Upload No Longer Exists", async () => {
    const result = await s3.send(
      new ListMultipartUploadsCommand({
        Bucket: containerName,
      }),
    );

    assert(!result.Uploads?.find((u) => u.UploadId === uploadId));
  });

  await t.step("Cleanup Bucket", async () => {
    await deleteBucketIfExists(s3, containerName);
  });
});
