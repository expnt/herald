import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3ClientConfig,
} from "aws-sdk/client-s3";
import {
  checkCreateBucket,
  checkDeleteObject,
  checkPutObject,
  deleteBucketIfExists,
  getS3Client,
} from "../../utils/s3.ts";
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
import { createTempFile } from "../../utils/file.ts";
import { assertEquals } from "std/assert";

const testSuccessfulDeleteObject = async (
  t: Deno.TestContext,
  buckets: string[],
  configs: S3ClientConfig[],
) => {
  const primaryBucket = buckets[0];
  const primaryConfig = configs[0];
  const s3 = getS3Client(primaryConfig);

  await t.step(async function cleanup() {
    await deleteBucketIfExists(s3, primaryBucket);
  });

  await t.step("Create bucket", async () => {
    const createBucket = new CreateBucketCommand({
      Bucket: primaryBucket,
    });
    const res = await s3.send(createBucket);
    checkCreateBucket(res);
  });

  await t.step("Put object into bucket", async () => {
    const tempFile = await createTempFile(1); // 1MB
    const body = await Deno.readFile(tempFile);
    const key = "put-object-mirror-test";
    const putCommand = new PutObjectCommand({
      Bucket: primaryBucket,
      Key: key,
      Body: body,
    });

    const result = await s3.send(putCommand);
    checkPutObject(result);
  });

  await t.step("Wait for mirror to sync", async () => {
    await new Promise((r) => setTimeout(r, SYNC_WAIT));
  });

  await t.step("Delete object from bucket", async () => {
    const key = "put-object-mirror-test";
    const deleteCommand = new DeleteObjectCommand({
      Bucket: primaryBucket,
      Key: key,
    });
    try {
      const deleteRes = await s3.send(deleteCommand);
      checkDeleteObject(deleteRes);
    } catch (error) {
      if ((error as Error).name === "BadResource") {
        // correct path
      } else {
        throw error;
      }
    }
  });

  await t.step("Wait for mirror to sync", async () => {
    await new Promise((r) => setTimeout(r, SYNC_WAIT));
  });

  await t.step("Check object deletion in primary and replicas", async () => {
    const key = "put-object-mirror-test";
    for (let i = 0; i < 3; i++) {
      const bucket = buckets[i];
      const config = configs[i];
      const s3 = getS3Client(config);

      const getObject = new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      });
      try {
        const res = await s3.send(getObject);
        assertEquals(404, res.$metadata.httpStatusCode);
      } catch (error) {
        if ((error as Error).name === "NoSuchKey") {
          // correct path
        } else if ((error as Error).name === "NotFound") {
          // correct path
        } else {
          throw error;
        }
      }
    }
  });

  // cleanup

  await t.step(async function cleanup() {
    await deleteBucketIfExists(s3, primaryBucket);
  });
};

Deno.test("test successful mirror deleteObject: Primary as S3", async (t) => {
  await testSuccessfulDeleteObject(t, s3MirrorBuckets, s3MirrorConfigs);
});

Deno.test("test successful mirror deleteObject: Primary as Swift", async (t) => {
  await testSuccessfulDeleteObject(t, swiftMirrorBuckets, swiftMirrorConfigs);
});

const testFailedDeleteObject = async (
  t: Deno.TestContext,
  buckets: string[],
  configs: S3ClientConfig[],
  storageService: string,
) => {
  const primaryBucket = buckets[0];
  const primaryConfig = configs[0];
  const s3 = getS3Client(primaryConfig);

  await t.step(async function cleanup() {
    await deleteBucketIfExists(s3, primaryBucket);
  });

  await t.step("Create bucket", async () => {
    const createBucket = new CreateBucketCommand({
      Bucket: primaryBucket,
    });
    const res = await s3.send(createBucket);
    checkCreateBucket(res);
  });

  await t.step("Put object into bucket", async () => {
    const tempFile = await createTempFile(1); // 1MB
    const key = "put-object-mirror-test";
    const body = await Deno.readFile(tempFile);
    const putCommand = new PutObjectCommand({
      Bucket: primaryBucket,
      Key: key,
      Body: body,
    });

    const result = await s3.send(putCommand);
    checkPutObject(result);
  });

  await t.step("Wait for mirror to sync", async () => {
    await new Promise((r) => setTimeout(r, SYNC_WAIT));
  });

  await t.step("Stop the storage service", async () => {
    await stopDockerContainer(storageService);
  });

  await t.step("Delete object from primary bucket", async () => {
    const key = "put-object-mirror-test";
    const deleteCommand = new DeleteObjectCommand({
      Bucket: primaryBucket,
      Key: key,
    });

    try {
      const deleteRes = await s3.send(deleteCommand);
      checkDeleteObject(deleteRes);
    } catch (error) {
      if ((error as Error).name === "TypeError") {
        // correct path
      } else {
        throw error;
      }
    }
  });

  await t.step("Wait for mirror to sync", async () => {
    await new Promise((r) => setTimeout(r, SYNC_WAIT));
  });

  await t.step("Restart the storage service", async () => {
    await startDockerContainer(storageService);
  });

  await t.step("Wait for service to restart", async () => {
    await new Promise((r) => setTimeout(r, 7000));
  });

  await t.step("Check object existence in primary and replicas", async () => {
    const key = "put-object-mirror-test";
    for (let i = 0; i < 3; i++) {
      const bucket = buckets[i];
      const config = configs[i];
      const s3 = getS3Client(config);

      const headObject = new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      });
      const res = await s3.send(headObject);
      // the object shouldn't be deleted from any of the storages
      assertEquals(200, res.$metadata.httpStatusCode);
    }
  });

  // cleanup
  await t.step(async function cleanup() {
    await deleteBucketIfExists(s3, primaryBucket);
  });
};

Deno.test("test failed mirror deleteObject: Primary as S3", async (t) => {
  await testFailedDeleteObject(
    t,
    s3MirrorBuckets,
    s3MirrorConfigs,
    s3_docker_container,
  );
});
