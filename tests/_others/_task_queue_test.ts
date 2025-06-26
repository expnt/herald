import { assertEquals } from "std/assert";
import { ListObjectsV2Command } from "aws-sdk/client-s3";
import { globalConfig } from "../../src/config/mod.ts";
import { getS3Client } from "../../utils/s3.ts";
import { S3Config } from "../../src/config/types.ts";

Deno.test("TaskStore creates queue.json for each bucket and storage_locks.json in remote storage", async (t) => {
  const taskStoreConfig = globalConfig.task_store_backend as S3Config;
  const s3 = getS3Client(taskStoreConfig);

  const taskStoreBucketName = taskStoreConfig.bucket;

  await t.step(
    "List objects in task store bucket and verify files",
    async () => {
      const listCommand = new ListObjectsV2Command({
        Bucket: taskStoreBucketName,
      });
      const res = await s3.send(listCommand);

      const objects = res.Contents?.map((obj) => obj.Key) || [];

      // Check for storage_locks.json
      assertEquals(
        objects.includes("storage_locks.json"),
        true,
        "storage_locks.json should exist in the task store bucket",
      );

      // Check for queue.json for each configured bucket (excluding the task-store bucket itself)
      const configuredBuckets = Object.keys(globalConfig.buckets).filter(
        (name) => name !== "task-store",
      );

      for (const bucketName of configuredBuckets) {
        const queueFileName = `${bucketName}/queue.json`;
        assertEquals(
          objects.includes(queueFileName),
          true,
          `${queueFileName} should exist for bucket ${bucketName}`,
        );
      }
    },
  );

  await t.step("Check for false positives (unexpected files)", async () => {
    const listCommand = new ListObjectsV2Command({
      Bucket: taskStoreBucketName,
    });
    const res = await s3.send(listCommand);
    const objects = res.Contents?.map((obj) => obj.Key) || [];

    const expectedObjects = new Set<string>();
    expectedObjects.add("storage_locks.json");

    const configuredBuckets = Object.keys(globalConfig.buckets).filter(
      (name) => name !== "task-store",
    );

    for (const bucketName of configuredBuckets) {
      expectedObjects.add(`${bucketName}/queue.json`);
    }

    const actualObjects = new Set<string>(objects.filter(Boolean) as string[]);

    // Check that the number of objects matches
    assertEquals(
      actualObjects.size,
      expectedObjects.size,
      `Expected ${expectedObjects.size} objects, but found ${actualObjects.size}`,
    );

    // Check that all actual objects are in the expected set
    for (const obj of actualObjects) {
      assertEquals(
        expectedObjects.has(obj),
        true,
        `Unexpected object found: ${obj}`,
      );
    }
  });
});
