import { assertEquals, assertStringIncludes } from "std/assert";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "aws-sdk/client-s3";
import { deleteBucketIfExists, setupBucket } from "../../../utils/s3.ts";

const bucketName = "s3-test";
const objectKey = "test-object.txt";
const testData = "Hello, this is a test file for range requests!";

const s3 = new S3Client({
  credentials: {
    accessKeyId: "minio",
    secretAccessKey: "password",
  },
  region: "local",
  forcePathStyle: true,
  endpoint: "http://localhost:8000",
});

Deno.test("Ranged GET returns partial content (AWS SDK)", async (t) => {
  await t.step(async function setup() {
    await setupBucket(s3, bucketName);
  });

  // Upload the object
  const putRes = await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      Body: testData,
      ContentType: "text/plain",
    }),
  );
  assertEquals(putRes.$metadata.httpStatusCode, 200);

  // Perform a ranged GET (bytes 7-18)
  const getRes = await s3.send(
    new GetObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      Range: "bytes=7-18",
    }),
  );
  assertEquals(getRes.$metadata.httpStatusCode, 206);
  assertStringIncludes(getRes.ContentRange ?? "", "bytes 7-18/");
  const partialContent = new TextDecoder().decode(
    await getRes.Body?.transformToByteArray(),
  );
  assertEquals(partialContent, "this is a te");

  await t.step(async function setup() {
    await deleteBucketIfExists(s3, bucketName);
  });
});
