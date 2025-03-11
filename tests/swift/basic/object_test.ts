import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "aws-sdk/client-s3";
import * as path from "std/path";
import { assert, assertEquals } from "std/assert";
import { loggingMiddleware, testConfig } from "../../utils/mod.ts";
import { deleteBucketIfExists, setupBucket } from "../../../utils/s3.ts";
import { proxyUrl } from "../../../src/config/mod.ts";
import { Upload } from "aws-sdk/lib-storage";
import { createTempFile, createTempStream } from "../../../utils/file.ts";

const containerName = "swift-test";

const s3 = new S3Client({
  ...testConfig,
  endpoint: proxyUrl,
});
s3.middlewareStack.add(loggingMiddleware, {
  step: "finalizeRequest",
});

const tempFile = await createTempFile(1); // 1MB file
const objectKey = path.basename(tempFile);

const uploadWithSDK = async (t: Deno.TestContext) => {
  // delete bucket if exists
  await t.step(async function cleanup() {
    await deleteBucketIfExists(s3, containerName);
  });

  // create bucket first
  const createBucketCommand = new CreateBucketCommand({
    Bucket: containerName,
  });

  const createBucketResponse = await s3.send(createBucketCommand);
  assertEquals(201, createBucketResponse.$metadata.httpStatusCode);

  const body = await Deno.readFile(tempFile);

  const uploadCommand = new PutObjectCommand({
    Bucket: containerName,
    Key: objectKey,
    Body: body,
  });

  const res = await s3.send(uploadCommand);
  assertEquals(201, res.$metadata.httpStatusCode);
};

Deno.test("upload an object to s3", uploadWithSDK);

Deno.test(async function listObjectsV2() {
  const command = new ListObjectsV2Command({
    Bucket: containerName,
  });

  const res = await s3.send(command);
  assertEquals(200, res.$metadata.httpStatusCode);
});

Deno.test(async function listObjects() {
  const listCommand = new ListObjectsCommand({
    Bucket: containerName,
  });
  const res = await s3.send(listCommand);
  assertEquals(200, res.$metadata.httpStatusCode);
});

Deno.test(async function getUploaded() {
  const getObject = new GetObjectCommand({
    Bucket: containerName,
    Key: objectKey,
  });
  const res = await s3.send(getObject);
  assertEquals(200, res.$metadata.httpStatusCode);
  const body = await res.Body?.transformToByteArray();
  assert(body instanceof Uint8Array);
});

Deno.test(async function deleteUploaded() {
  const deleteObject = new DeleteObjectCommand({
    Bucket: containerName,
    Key: path.basename(tempFile),
  });

  const res = await s3.send(deleteObject);
  assertEquals(204, res.$metadata.httpStatusCode);
});

Deno.test(async function streamUpload() {
  await setupBucket(s3, containerName);

  const { stream: fileStream, fileName, size } = await createTempStream();

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: containerName,
      Key: fileName,
      Body: fileStream,
      ContentLength: size,
    },
  });

  const res = await upload.done();
  assertEquals(201, res.$metadata.httpStatusCode);
});

Deno.test(async function nonExistingBucketListObject(t) {
  await t.step(async function cleanup() {
    await deleteBucketIfExists(s3, containerName);
  });

  const listCmd = new ListObjectsV2Command({
    Bucket: containerName,
  });

  try {
    // expected to fail
    const _ = await s3.send(listCmd);
  } catch (_error) {
    // expected
  }
});

Deno.test(async function emptyBucketListObject(t) {
  await t.step(async function setup() {
    await setupBucket(s3, containerName);
  });

  const listCmd = new ListObjectsV2Command({
    Bucket: containerName,
  });

  const res = await s3.send(listCmd);
  assertEquals(res.KeyCount, 0);
  assertEquals(200, res.$metadata.httpStatusCode);

  await t.step(async function setup() {
    await deleteBucketIfExists(s3, containerName);
  });
});
