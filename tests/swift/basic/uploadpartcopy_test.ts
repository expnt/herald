import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
} from "aws-sdk/client-s3";
import { assert, assertEquals } from "std/assert";
import { loggingMiddleware } from "../../utils/mod.ts";
import { configInit, globalConfig, proxyUrl } from "../../../src/config/mod.ts";
import { checkHeadObject, deleteBucketIfExists } from "../../../utils/s3.ts";
import { createTempFile } from "../../../utils/file.ts";

const containerName = "swift-test";
const objectKey = "test-object.txt";
const sourceObjectKey = "source-object.txt";

await configInit();
const containerConfig = globalConfig.buckets[containerName].config;
const s3 = new S3Client({
  credentials: "accessKeyId" in containerConfig.credentials
    ? containerConfig.credentials
    : {
      accessKeyId: containerConfig.credentials.username,
      secretAccessKey: containerConfig.credentials.password,
    },
  region: containerConfig.region,
  forcePathStyle: true,
  endpoint: proxyUrl,
});

s3.middlewareStack.add(loggingMiddleware, {
  step: "finalizeRequest",
});

Deno.test("Upload Part Copy Flow", async (t) => {
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
  });

  // Create a source object to copy from
  await t.step("Create Source Object", async () => {
    const tempFile = await createTempFile(10); // 10MB file
    const body = await Deno.readFile(tempFile);
    const result = await s3.send(
      new PutObjectCommand({
        Bucket: containerName,
        Key: sourceObjectKey,
        Body: body,
      }),
    );
    assertEquals(result.$metadata.httpStatusCode, 200);
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

  await t.step("Upload Part Copy", async () => {
    // Using fetch directly since AWS SDK doesn't expose UploadPartCopy
    const url = new URL(`${proxyUrl}/${containerName}/${objectKey}`);
    url.searchParams.append("partNumber", "1");
    url.searchParams.append("uploadId", uploadId);

    // Get credentials in a type-safe way
    const credentials = "accessKeyId" in containerConfig.credentials
      ? {
        accessKeyId: containerConfig.credentials.accessKeyId,
        secretAccessKey: containerConfig.credentials.secretAccessKey,
      }
      : {
        accessKeyId: containerConfig.credentials.username,
        secretAccessKey: containerConfig.credentials.password,
      };

    const response = await fetch(url.toString(), {
      method: "PUT",
      headers: {
        "Authorization":
          `AWS ${credentials.accessKeyId}:${credentials.secretAccessKey}`,
        "x-amz-copy-source": `${containerName}/${sourceObjectKey}`,
        "x-amz-copy-source-range": "bytes=0-5242880", // Copy first 5MB
      },
    });

    assertEquals(response.status, 200);
    const responseText = await response.text();
    assert(responseText.includes("<CopyPartResult"));
    assert(responseText.includes("<ETag>"));

    // Extract ETag from the XML response
    const etagMatch = responseText.match(/<ETag>([^<]+)<\/ETag>/);
    assert(etagMatch);
    partETag = etagMatch[1];
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

  await t.step("Complete Multipart Upload", async () => {
    const result = await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: containerName,
        Key: objectKey,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [
            {
              ETag: partETag,
              PartNumber: 1,
            },
          ],
        },
      }),
    );

    assertEquals(result.$metadata.httpStatusCode, 200);
    assert(result.ETag);
  });

  await t.step("Verify Uploaded Object", async () => {
    const result = await s3.send(
      new HeadObjectCommand({
        Bucket: containerName,
        Key: objectKey,
      }),
    );
    checkHeadObject(result);
    assert(result.ContentLength);
    // The content length should match the range we copied (5MB)
    assertEquals(result.ContentLength, 5242880);
  });

  await t.step("Cleanup", async () => {
    await deleteBucketIfExists(s3, containerName);
  });
});
