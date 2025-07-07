import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "aws-sdk/client-s3";
import { assertEquals } from "std/assert";
import { configInit, globalConfig, proxyUrl } from "../../../src/config/mod.ts";
import { deleteBucketIfExists } from "../../../utils/s3.ts";

const containerName = "swift-test";
const objectKeys = ["obj1.txt", "obj2.txt", "obj3.txt"];

await configInit();
const containerConfig = globalConfig.buckets[containerName]?.config ||
  globalConfig.buckets["swift-test"].config;
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

Deno.test("DeleteObjects operation deletes multiple objects", async (t) => {
  // Cleanup before test
  await t.step("cleanup before", async () => {
    await deleteBucketIfExists(s3, containerName);
  });

  // Create bucket
  await t.step("create bucket", async () => {
    const res = await s3.send(
      new CreateBucketCommand({ Bucket: containerName }),
    );
    assertEquals(res.$metadata.httpStatusCode, 200);
  });

  // Put objects
  await t.step("put objects", async () => {
    for (const key of objectKeys) {
      const putRes = await s3.send(
        new PutObjectCommand({
          Bucket: containerName,
          Key: key,
          Body: new TextEncoder().encode(`test-content-${key}`),
        }),
      );
      assertEquals(putRes.$metadata.httpStatusCode, 200);
    }
  });

  // Check objects exist
  await t.step("check objects exist", async () => {
    for (const key of objectKeys) {
      const headRes = await s3.send(
        new HeadObjectCommand({
          Bucket: containerName,
          Key: key,
        }),
      );
      assertEquals(headRes.$metadata.httpStatusCode, 200);
    }
  });

  // Delete objects
  await t.step("delete objects", async () => {
    const delRes = await s3.send(
      new DeleteObjectsCommand({
        Bucket: containerName,
        Delete: {
          Objects: objectKeys.map((Key) => ({ Key })),
          Quiet: false,
        },
      }),
    );
    assertEquals(delRes.$metadata.httpStatusCode, 200);
  });

  // Check objects are deleted
  await t.step("check objects deleted", async () => {
    for (const key of objectKeys) {
      const res = await s3.send(
        new HeadObjectCommand({
          Bucket: containerName,
          Key: key,
        }),
      ).catch((err) => err);
      // AWS SDK returns an error object for not found; check status code
      if (res.$metadata && res.$metadata.httpStatusCode !== undefined) {
        // If for some reason a response is returned, check for 404
        assertEquals(res.$metadata.httpStatusCode, 404);
      } else if (
        res.name === "NotFound" || res.$metadata?.httpStatusCode === undefined
      ) {
        // If error object, check error name
        assertEquals(res.name, "NotFound");
      } else {
        throw new Error(`Unexpected result: ${JSON.stringify(res)}`);
      }
    }
  });

  // Cleanup after test
  await t.step("cleanup after", async () => {
    await deleteBucketIfExists(s3, containerName);
  });
});
