import {
  CreateBucketCommand,
  DeleteBucketCommand,
  ListBucketsCommand,
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
  assertEquals(200, result.$metadata.httpStatusCode);
});

Deno.test(async function deleteContainer() {
  const command = new DeleteBucketCommand({
    Bucket: containerName,
  });

  const result = await s3.send(command);
  assertEquals(204, result.$metadata.httpStatusCode);
});

Deno.test(async function listBucketsReturnsS3Schema() {
  const listCommand = new ListBucketsCommand({});
  // List buckets using the S3 client
  const result = await s3.send(listCommand);

  // S3 protocol: result.Buckets is an array, result.Owner is an object
  // See: https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/clients/client-s3/interfaces/listbucketsoutput.html
  assertEquals(typeof result, "object");
  // Buckets should be an array
  if (!Array.isArray(result.Buckets)) {
    throw new Error("Buckets is not an array in S3 ListBuckets response");
  }
  // Each bucket should have Name and CreationDate
  for (const bucket of result.Buckets) {
    if (typeof bucket.Name !== "string") {
      throw new Error("Bucket.Name is not a string");
    }
    if (
      typeof bucket.CreationDate !== "string" &&
      !(bucket.CreationDate instanceof Date)
    ) {
      throw new Error("Bucket.CreationDate is not a string or Date");
    }
  }
  // Owner should be present and have ID and DisplayName
  if (
    !result.Owner || typeof result.Owner.ID !== "string" ||
    typeof result.Owner.DisplayName !== "string"
  ) {
    throw new Error("Owner is missing or malformed in S3 ListBuckets response");
  }
});
