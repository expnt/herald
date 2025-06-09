import {
  CreateBucketCommand,
  DeleteBucketCommand,
  S3Client,
} from "aws-sdk/client-s3";
import { assertEquals } from "std/assert";
import { loggingMiddleware } from "../../utils/mod.ts";
import { configInit, globalConfig, proxyUrl } from "../../../src/config/mod.ts";
import { deleteBucketIfExists } from "../../../utils/s3.ts";

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

Deno.test(async function createContainer(t) {
  await t.step(async function cleanup() {
    await deleteBucketIfExists(s3, containerName);
  });

  const command = new CreateBucketCommand({
    Bucket: containerName,
  });

  const result = await s3.send(command);
  assertEquals(201, result.$metadata.httpStatusCode);
});

Deno.test(async function deleteContainer() {
  const command = new DeleteBucketCommand({
    Bucket: containerName,
  });

  const result = await s3.send(command);
  assertEquals(204, result.$metadata.httpStatusCode);
});
