import {
  s3_docker_container,
  s3MirrorBuckets,
  s3MirrorConfigs,
  startDockerContainer,
  stopDockerContainer,
  SYNC_WAIT,
} from "./mod.ts";
import {
  checkCreateBucket,
  checkHeadObject,
  checkPutObject,
  deleteBucketIfExists,
  getS3Client,
} from "../../utils/s3.ts";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3ClientConfig,
} from "aws-sdk/client-s3";
import { createTempFile } from "../../utils/file.ts";
import { assertEquals } from "std/assert";
import { swiftMirrorBuckets } from "./mod.ts";
import { swiftMirrorConfigs } from "./mod.ts";

const testSuccessfulPutObject = async (
  t: Deno.TestContext,
  buckets: string[],
  configs: S3ClientConfig[],
) => {
  const primaryBucket = buckets[0];
  const primaryConfig = configs[0];
  const key = "put-object-mirror-test";
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

  await t.step("Upload object", async () => {
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

  await t.step("Wait for mirror sync", async () => {
    // sleep for 1 min to wait for the mirror to sync
    await new Promise((r) => setTimeout(r, SYNC_WAIT));
  });

  await t.step("Check object in primary and replicas", async () => {
    // check in primary and replicas for the object
    for (let i = 0; i < 3; i++) {
      const bucket = buckets[i];
      const config = configs[i];
      const s3 = getS3Client(config);

      const headObject = new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      });
      const res = await s3.send(headObject);
      checkHeadObject(res);
    }
  });

  await t.step(async function cleanup() {
    await deleteBucketIfExists(s3, primaryBucket);
  });
};

Deno.test("test successful mirror putObject: Primary as S3", async (t) => {
  await testSuccessfulPutObject(t, s3MirrorBuckets, s3MirrorConfigs);
});

Deno.test("test successful mirror putObject: Primary as Swift", async (t) => {
  await testSuccessfulPutObject(t, swiftMirrorBuckets, swiftMirrorConfigs);
});

const testFailedPutObject = async (
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
  const key = "put-object-mirror-test";

  await t.step("Create bucket", async () => {
    const createBucket = new CreateBucketCommand({
      Bucket: primaryBucket,
    });
    const res = await s3.send(createBucket);
    checkCreateBucket(res);
  });

  // stop the storage service
  await t.step("Stop storage service", async () => {
    await stopDockerContainer(storageService);
  });

  await t.step("Upload object", async () => {
    const tempFile = await createTempFile(1); // 1MB
    const body = await Deno.readFile(tempFile);
    const putCommand = new PutObjectCommand({
      Bucket: primaryBucket,
      Key: key,
      Body: body,
    });

    try {
      const res = await s3.send(putCommand);
      // the object shouldn't be inside any of the storages
      assertEquals(404, res.$metadata.httpStatusCode);
    } catch (error) {
      if ((error as Error).name === "BadResource") {
        // correct path
      } else {
        throw error;
      }
    }
  });

  await t.step("Wait for mirror sync", async () => {
    // sleep for 1 min to wait for the mirror to sync
    await new Promise((r) => setTimeout(r, SYNC_WAIT));
  });

  await t.step("Restart storage service", async () => {
    // restart the storage service
    await startDockerContainer(storageService);
  });

  await t.step("Check object in primary and replicas", async () => {
    // check in primary and replicas for the object, it shouldn't be there
    // ensure consistency
    for (let i = 0; i < 3; i++) {
      const bucket = buckets[i];
      const config = configs[i];
      const s3 = getS3Client(config);

      const getObject = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });
      try {
        const res = await s3.send(getObject);
        // the object shouldn't be inside any of the storages
        assertEquals(404, res.$metadata.httpStatusCode);
      } catch (error) {
        if ((error as Error).name === "NoSuchKey") {
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

Deno.test("test failed mirror putObject: Primary as S3", async (t) => {
  await testFailedPutObject(
    t,
    s3MirrorBuckets,
    s3MirrorConfigs,
    s3_docker_container,
  );
});
