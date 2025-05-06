import {
  CopyObjectCommand,
  CreateBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "aws-sdk/client-s3";
import { loggingMiddleware } from "../../utils/mod.ts";
import {
  checkCopyObject,
  checkCreateBucket,
  checkHeadObject,
  checkPutObject,
  deleteBucketIfExists,
} from "../../../utils/s3.ts";
import { configInit, globalConfig, proxyUrl } from "../../../src/config/mod.ts";
import { createTempFile } from "../../../utils/file.ts";

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

Deno.test(async function copyObject(t) {
  const destPath = "path/to/mirror-dest-key";
  const key = "put-object-mirror-test";

  await t.step(async function cleanup() {
    await deleteBucketIfExists(s3, containerName);
  });

  await t.step("Create primary", async () => {
    const createBucket = new CreateBucketCommand({
      Bucket: containerName,
    });
    const res = await s3.send(createBucket);
    checkCreateBucket(res);
  });

  await t.step("Put object in primary bucket", async () => {
    const tempFile = await createTempFile(1); // 1MB
    const body = await Deno.readFile(tempFile);
    const putCommand = new PutObjectCommand({
      Bucket: containerName,
      Key: key,
      Body: body,
    });

    const result = await s3.send(putCommand);
    checkPutObject(result);
  });

  await t.step("Copy object to destination bucket", async () => {
    const copyCommand = new CopyObjectCommand({
      Bucket: containerName,
      Key: destPath,
      CopySource: `/${containerName}/${key}`,
    });
    const copyRes = await s3.send(copyCommand);
    checkCopyObject(copyRes);
  });

  await t.step("Check if copied", async () => {
    const headObject = new HeadObjectCommand({
      Bucket: containerName,
      Key: destPath,
    });
    const res = await s3.send(headObject);
    checkHeadObject(res);
  });

  await t.step(async function cleanup() {
    await deleteBucketIfExists(s3, containerName);
  });
});
