import {
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  S3ClientConfig,
} from "aws-sdk/client-s3";
import {
  checkCreateBucket,
  deleteBucketIfExists,
  getS3Client,
} from "../../utils/s3.ts";
import { assertEquals } from "std/assert";
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

const testSuccessfulCreateBucketAndDeleteBucket = async (
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

  await t.step("create bucket", async () => {
    const createBucket = new CreateBucketCommand({
      Bucket: primaryBucket,
    });
    const res = await s3.send(createBucket);
    checkCreateBucket(res);
  });

  await t.step("wait for sync", async () => {
    await new Promise((r) => setTimeout(r, SYNC_WAIT));
  });

  await t.step("check bucket in primary and replicas", async () => {
    for (let i = 0; i < 3; i++) {
      const bucket = buckets[i];
      const config = configs[i];
      const s3 = getS3Client(config);

      const headObject = new HeadBucketCommand({
        Bucket: bucket,
      });
      const res = await s3.send(headObject);
      assertEquals(res.$metadata.httpStatusCode, 200);
    }
  });

  await t.step("delete bucket", async () => {
    const deleteBucket = new DeleteBucketCommand({
      Bucket: primaryBucket,
    });
    const deleteRes = await s3.send(deleteBucket);
    assertEquals(deleteRes.$metadata.httpStatusCode, 204);
  });

  await t.step("wait for sync", async () => {
    await new Promise((r) => setTimeout(r, SYNC_WAIT));
  });

  await t.step("check bucket deletion in primary and replicas", async () => {
    for (let i = 0; i < 3; i++) {
      const bucket = buckets[i];
      const config = configs[i];
      const s3 = getS3Client(config);

      const headBucket = new HeadBucketCommand({
        Bucket: bucket,
      });

      try {
        const res = await s3.send(headBucket);
        assertEquals(res.$metadata.httpStatusCode, 404);
      } catch (err) {
        assertEquals((err as Error).name, "NotFound");
      }
    }
  });

  // cleanup

  await t.step(async function cleanup() {
    await deleteBucketIfExists(s3, primaryBucket);
  });
};

Deno.test("test successful create bucket and delete bucket: Primary S3", async (t) => {
  await testSuccessfulCreateBucketAndDeleteBucket(
    t,
    s3MirrorBuckets,
    s3MirrorConfigs,
  );
});

Deno.test("test successful create bucket and delete bucket: Primary Swift", async (t) => {
  await testSuccessfulCreateBucketAndDeleteBucket(
    t,
    swiftMirrorBuckets,
    swiftMirrorConfigs,
  );
});

const testFailedCreateBucket = async (
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

  await t.step("stop storage service", async () => {
    await stopDockerContainer(storageService);
  });

  await t.step("attempt to create bucket", async () => {
    const createBucket = new CreateBucketCommand({
      Bucket: primaryBucket,
    });
    try {
      await s3.send(createBucket);
    } catch (error) {
      if ((error as Error).name === "InternalServerError") {
        // correct path
      } else {
        throw error;
      }
    }
  });

  await t.step("wait for sync", async () => {
    await new Promise((r) => setTimeout(r, SYNC_WAIT));
  });

  await t.step("restart storage service", async () => {
    await startDockerContainer(storageService);
  });

  await t.step("Wait for service to restart", async () => {
    await new Promise((r) => setTimeout(r, 7000));
  });

  await t.step(
    "verify bucket not created in primary and replicas",
    async () => {
      for (let i = 0; i < 3; i++) {
        const bucket = buckets[i];
        const config = configs[i];
        const s3 = getS3Client(config);

        try {
          const headBucket = new HeadBucketCommand({
            Bucket: bucket,
          });
          const res = await s3.send(headBucket);
          assertEquals(res.$metadata.httpStatusCode, 404);
        } catch (error) {
          // this means the error is 404
          assertEquals((error as Error).name, "NotFound");
        }
      }
    },
  );

  // cleanup
  await t.step(async function cleanup() {
    await deleteBucketIfExists(s3, primaryBucket);
  });
};

Deno.test("test failed create bucket: Primary S3", async (t) => {
  await testFailedCreateBucket(
    t,
    s3MirrorBuckets,
    s3MirrorConfigs,
    s3_docker_container,
  );
});

const testFailedDeleteBucket = async (
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

  await t.step("create bucket", async () => {
    const createBucket = new CreateBucketCommand({
      Bucket: primaryBucket,
    });
    const res = await s3.send(createBucket);
    checkCreateBucket(res);
  });

  await t.step("wait for sync", async () => {
    await new Promise((r) => setTimeout(r, SYNC_WAIT));
  });

  await t.step("verify bucket creation in primary and replicas", async () => {
    for (let i = 0; i < 3; i++) {
      const bucket = buckets[i];
      const config = configs[i];
      const s3 = getS3Client(config);

      const headObject = new HeadBucketCommand({
        Bucket: bucket,
      });
      const res = await s3.send(headObject);
      assertEquals(res.$metadata.httpStatusCode, 200);
    }
  });

  await t.step("stop storage service", async () => {
    await stopDockerContainer(storageService);
  });

  await t.step("attempt to delete bucket", async () => {
    const deleteBucket = new DeleteBucketCommand({
      Bucket: primaryBucket,
    });
    try {
      const deleteRes = await s3.send(deleteBucket);
      assertEquals(deleteRes.$metadata.httpStatusCode, 204);
    } catch (error) {
      if ((error as Error).name === "InternalServerError") {
        // correct path
      } else {
        throw error;
      }
    }
  });

  await t.step("wait for sync", async () => {
    await new Promise((r) => setTimeout(r, SYNC_WAIT));
  });

  await t.step("restart storage service", async () => {
    await startDockerContainer(storageService);
  });

  await t.step("Wait for service to restart", async () => {
    await new Promise((r) => setTimeout(r, 7000));
  });

  await t.step(
    "verify buckets still exist in primary and replicas",
    async () => {
      for (let i = 0; i < 3; i++) {
        const bucket = buckets[i];
        const config = configs[i];
        const s3 = getS3Client(config);

        const headBucket = new HeadBucketCommand({
          Bucket: bucket,
        });
        const res = await s3.send(headBucket);
        assertEquals(res.$metadata.httpStatusCode, 200);
      }
    },
  );

  // cleanup
  await t.step(async function cleanup() {
    await deleteBucketIfExists(s3, primaryBucket);
  });
};

Deno.test("test failing deleteBucket: Primary S3", async (t) => {
  await testFailedDeleteBucket(
    t,
    s3MirrorBuckets,
    s3MirrorConfigs,
    s3_docker_container,
  );
});
