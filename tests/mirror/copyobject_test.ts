import {
  CopyObjectCommand,
  CreateBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3ClientConfig,
} from "aws-sdk/client-s3";
import {
  checkCopyObject,
  checkCreateBucket,
  checkHeadObject,
  checkPutObject,
  deleteBucketIfExists,
  getS3Client,
} from "../../utils/s3.ts";
import { createTempFile } from "../../utils/file.ts";
import {
  s3_docker_container,
  s3MirrorBuckets,
  s3MirrorConfigs,
  startDockerContainer,
  stopDockerContainer,
  swiftMirrorBuckets,
  swiftMirrorConfigs,
  SYNC_WAIT,
} from "./mod.ts";
import { assertEquals } from "std/assert";

const testSuccessfulCopyObject = async (
  t: Deno.TestContext,
  buckets: string[],
  configs: S3ClientConfig[],
) => {
  const destPath = "path/to/mirror-dest-key";
  const key = "put-object-mirror-test";

  const primaryBucket = buckets[0];
  const primaryConfig = configs[0];
  const s3 = getS3Client(primaryConfig);

  await t.step(async function cleanup() {
    await deleteBucketIfExists(s3, primaryBucket);
  });

  await t.step("Create primary", async () => {
    const createBucket = new CreateBucketCommand({
      Bucket: primaryBucket,
    });
    const res = await s3.send(createBucket);
    checkCreateBucket(res);
  });

  await t.step("Put object in primary bucket", async () => {
    const tempFile = await createTempFile(1); // 1MB
    const body = await Deno.readFile(tempFile);
    const putCommand = new PutObjectCommand({
      Bucket: primaryBucket,
      Key: key,
      Body: body,
    });

    const result = await s3.send(putCommand);
    checkPutObject(result);
  });

  await t.step("Wait for sync time", async () => {
    // s// sleep and wait for the mirror to sync
    await new Promise((r) => setTimeout(r, SYNC_WAIT));
  });

  await t.step("Copy object to destination bucket", async () => {
    const copyCommand = new CopyObjectCommand({
      Bucket: primaryBucket,
      Key: destPath,
      CopySource: `/${primaryBucket}/${key}`,
    });
    const copyRes = await s3.send(copyCommand);
    checkCopyObject(copyRes);
  });

  await t.step("Wait for sync time", async () => {
    // s// sleep and wait for the mirror to sync
    await new Promise((r) => setTimeout(r, SYNC_WAIT));
  });

  await t.step("Check object in primary and replicas", async () => {
    for (let i = 0; i < 3; i++) {
      const config = configs[i];
      const s3 = getS3Client(config);

      const headObject = new HeadObjectCommand({
        Bucket: primaryBucket,
        Key: destPath,
      });
      const res = await s3.send(headObject);
      checkHeadObject(res);
    }
  });

  await t.step(async function cleanup() {
    await deleteBucketIfExists(s3, primaryBucket);
  });
};

Deno.test("test successful copy object: Primary S3", async (t) => {
  await testSuccessfulCopyObject(t, s3MirrorBuckets, s3MirrorConfigs);
});

Deno.test("test successful copy object: Primary Swift", async (t) => {
  await testSuccessfulCopyObject(t, swiftMirrorBuckets, swiftMirrorConfigs);
});

const testFailedCopyObject = async (
  t: Deno.TestContext,
  buckets: string[],
  configs: S3ClientConfig[],
  storageService: string,
) => {
  const destKey = "path/to/mirror-dest-key";
  const key = "put-object-mirror-test";

  const primaryBucket = buckets[0];
  const primaryConfig = configs[0];
  const s3 = getS3Client(primaryConfig);

  await t.step(async function cleanup() {
    await deleteBucketIfExists(s3, primaryBucket);
  });

  await t.step("Create primary and destination buckets", async () => {
    const createBucket = new CreateBucketCommand({
      Bucket: primaryBucket,
    });
    const res = await s3.send(createBucket);
    checkCreateBucket(res);
  });

  await t.step("Put object in primary bucket", async () => {
    const tempFile = await createTempFile(1); // 1MB
    const body = await Deno.readFile(tempFile);
    const putCommand = new PutObjectCommand({
      Bucket: primaryBucket,
      Key: key,
      Body: body,
    });

    const result = await s3.send(putCommand);
    checkPutObject(result);
  });

  await t.step("Wait for sync time", async () => {
    // s// sleep and wait for the mirror to sync
    await new Promise((r) => setTimeout(r, SYNC_WAIT));
  });

  await t.step("Stop the storage service", async () => {
    await stopDockerContainer(storageService);
  });

  await t.step("Attempt to copy object to destination bucket", async () => {
    const copyCommand = new CopyObjectCommand({
      Bucket: primaryBucket,
      Key: destKey,
      CopySource: `/${primaryBucket}/${key}`,
    });

    try {
      const copyRes = await s3.send(copyCommand);
      checkCopyObject(copyRes);
    } catch (error) {
      if ((error as Error).name === "InternalServerError") {
        // correct path
      } else {
        throw error;
      }
    }
  });

  await t.step("Wait for sync time", async () => {
    // s// sleep and wait for the mirror to sync
    await new Promise((r) => setTimeout(r, SYNC_WAIT));
  });

  await t.step("Restart storage service", async () => {
    await startDockerContainer(storageService);
  });

  await t.step("Wait for service to restart", async () => {
    await new Promise((r) => setTimeout(r, 7000));
  });

  await t.step("Check that object was not copied", async () => {
    for (let i = 0; i < 3; i++) {
      const config = configs[i];
      const s3 = getS3Client(config);

      const headObject = new HeadObjectCommand({
        Bucket: primaryBucket,
        Key: destKey,
      });
      try {
        const res = await s3.send(headObject);
        assertEquals(404, res.$metadata.httpStatusCode);
      } catch (error) {
        if ((error as Error).name === "NotFound") {
          // correct path
        } else {
          throw error;
        }
      }
    }
  });

  await t.step(async function cleanup() {
    await deleteBucketIfExists(s3, primaryBucket);
  });
};

Deno.test("test failed copy object: Primary S3", async (t) => {
  await testFailedCopyObject(
    t,
    s3MirrorBuckets,
    s3MirrorConfigs,
    s3_docker_container,
  );
});
