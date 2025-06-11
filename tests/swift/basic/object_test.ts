import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as path from "std/path/";
import { assert, assertEquals } from "std/assert";
import { loggingMiddleware } from "../../utils/mod.ts";
import { deleteBucketIfExists, setupBucket } from "../../../utils/s3.ts";
import { configInit, globalConfig, proxyUrl } from "../../../src/config/mod.ts";
import { Upload } from "aws-sdk/lib-storage";
import { createTempFile, createTempStream } from "../../../utils/file.ts";

const containerName = "swift-test";

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
  assertEquals(200, createBucketResponse.$metadata.httpStatusCode);

  const body = await Deno.readFile(tempFile);

  const uploadCommand = new PutObjectCommand({
    Bucket: containerName,
    Key: objectKey,
    Body: body,
  });

  const res = await s3.send(uploadCommand);
  assertEquals(200, res.$metadata.httpStatusCode);
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
  assertEquals(200, res.$metadata.httpStatusCode);
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

Deno.test(async function presignUpload(t) {
  await t.step(async function setup() {
    await setupBucket(s3, containerName);
  });

  const headers = new Headers();
  headers.set("Content-Type", "application/octet-stream");
  headers.set("Content-Length", (1 * 1024 * 1024).toString());

  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: containerName,
      Key: objectKey,
    }),
    {
      expiresIn: 60,
    },
  );

  const body = await Deno.readFile(tempFile);

  const res = await fetch(url, {
    method: "PUT",
    body,
    headers,
  });
  if (!res.ok) {
    throw new Error("error uploading through presign: ", { cause: res });
  }
  assert(await res.blob());
});

Deno.test(async function presignDownload() {
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: containerName,
      Key: objectKey,
    }),
    {
      expiresIn: 60,
    },
  );

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error("error downloading through presign: ", { cause: resp });
  }
  assert(await resp.blob());
});

Deno.test(async function presignDelete() {
  const url = await getSignedUrl(
    s3,
    new DeleteObjectCommand({
      Bucket: containerName,
      Key: objectKey,
    }),
    {
      expiresIn: 60,
    },
  );

  const res = await fetch(url, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error("error deleting through presign: ", { cause: res });
  }
  assert(await res.blob());
});
