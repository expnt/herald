import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "aws-sdk/client-s3";
import { assert, assertEquals } from "std/assert";
// import { loggingMiddleware } from "../../utils/mod.ts";
import { configInit, globalConfig, proxyUrl } from "../../../src/config/mod.ts";
import { checkHeadObject, deleteBucketIfExists } from "../../../utils/s3.ts";
import { createTempFile } from "../../../utils/file.ts";
import { SYNC_WAIT } from "../../mirror/mod.ts";

const containerName = "swift-test";
const objectKey = "test-object.txt";
const multipartIndexPath = ".herald-state/multipart-uploads/index.json";

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

// s3.middlewareStack.add(loggingMiddleware, {
//   step: "finalizeRequest",
// });

Deno.test("Multipart Upload Flow", async (t) => {
  await t.step("Cleanup bucket if exists", async () => {
    await deleteBucketIfExists(s3, containerName);
  });

  await t.step("Create Bucket", async () => {
    const result = await s3.send(
      new CreateBucketCommand({
        Bucket: containerName,
      }),
    );
    assertEquals(result.$metadata.httpStatusCode, 200);

    // Create empty index.json file for multipart uploads
    const createIndexResult = await s3.send(
      new PutObjectCommand({
        Bucket: containerName,
        Key: multipartIndexPath,
        Body: JSON.stringify({
          lastUpdated: new Date().toISOString(),
          uploads: [],
        }),
        ContentType: "application/json",
      }),
    );
    assertEquals(createIndexResult.$metadata.httpStatusCode, 200);
  });

  let uploadId = "";

  await t.step("Initiate Multipart Upload", async () => {
    const result = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: containerName,
        Key: objectKey,
      }),
    );

    assert(result.UploadId);
    uploadId = result.UploadId!;
    assertEquals(result.Key, objectKey);
  });

  let partETag = "";

  await t.step("Upload Part 1", async () => {
    const result = await s3.send(
      new UploadPartCommand({
        Bucket: containerName,
        Key: objectKey,
        PartNumber: 1,
        UploadId: uploadId,
        Body: new TextEncoder().encode("Hello multipart world!"),
      }),
    );

    assert(result.ETag);
    partETag = result.ETag!;
  });

  await t.step("List Parts", async () => {
    const result = await s3.send(
      new ListPartsCommand({
        Bucket: containerName,
        Key: objectKey,
        UploadId: uploadId,
      }),
    );

    assertEquals(result.Parts?.length, 1);
    assertEquals(result.Parts?.[0].PartNumber, 1);
    assertEquals(result.Parts?.[0].ETag, partETag);
  });

  await t.step("List Multipart Uploads", async () => {
    const result = await s3.send(
      new ListMultipartUploadsCommand({
        Bucket: containerName,
      }),
    );

    assert(result.Uploads?.find((u) => u.UploadId === uploadId));
  });

  await t.step("Complete Multipart Upload", async () => {
    const result = await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: containerName,
        Key: objectKey,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [
            {
              PartNumber: 1,
              ETag: partETag,
            },
          ],
        },
      }),
    );

    assertEquals(result.Key, objectKey);
  });

  await t.step("Cleanup Bucket", async () => {
    await deleteBucketIfExists(s3, containerName);
  });
});

Deno.test("Abort Multipart Upload Flow", async (t) => {
  await t.step("Cleanup bucket if exists", async () => {
    await deleteBucketIfExists(s3, containerName);
  });

  await t.step("Create Bucket", async () => {
    const result = await s3.send(
      new CreateBucketCommand({
        Bucket: containerName,
      }),
    );
    assertEquals(result.$metadata.httpStatusCode, 200);

    // Create empty index.json file for multipart uploads
    const createIndexResult = await s3.send(
      new PutObjectCommand({
        Bucket: containerName,
        Key: multipartIndexPath,
        Body: JSON.stringify({
          lastUpdated: new Date().toISOString(),
          uploads: [],
        }),
        ContentType: "application/json",
      }),
    );
    assertEquals(createIndexResult.$metadata.httpStatusCode, 200);
  });

  let uploadId = "";

  await t.step("Initiate Multipart Upload", async () => {
    const result = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: containerName,
        Key: objectKey,
      }),
    );

    assert(result.UploadId);
    uploadId = result.UploadId!;
    assertEquals(result.Key, objectKey);
  });

  await t.step("Upload Part 1", async () => {
    const result = await s3.send(
      new UploadPartCommand({
        Bucket: containerName,
        Key: objectKey,
        PartNumber: 1,
        UploadId: uploadId,
        Body: new TextEncoder().encode("Hello multipart world!"),
      }),
    );

    assert(result.ETag);
  });

  await t.step("Verify Upload Exists", async () => {
    const result = await s3.send(
      new ListMultipartUploadsCommand({
        Bucket: containerName,
      }),
    );

    assert(result.Uploads?.find((u) => u.UploadId === uploadId));
  });

  await t.step("Abort Multipart Upload", async () => {
    const result = await s3.send(
      new AbortMultipartUploadCommand({
        Bucket: containerName,
        Key: objectKey,
        UploadId: uploadId,
      }),
    );

    assertEquals(result.$metadata.httpStatusCode, 204);
  });

  await t.step("Verify Upload No Longer Exists", async () => {
    const result = await s3.send(
      new ListMultipartUploadsCommand({
        Bucket: containerName,
      }),
    );

    assert(!result.Uploads?.find((u) => u.UploadId === uploadId));
  });

  await t.step("Cleanup Bucket", async () => {
    await deleteBucketIfExists(s3, containerName);
  });
});

const testMPULargeFile = async (t: Deno.TestContext, containerName: string) => {
  const largeObjectKey = "large-test-object.bin";
  const largeFileSizeMB = 100;
  // Swift's minimum part size is 1MB, S3's is 5MB (except last part).
  // Let's use 5MB parts to be compatible with S3 spec.
  const partSizeMB = 5;
  const partSize = partSizeMB * 1024 * 1024; // 5MB in bytes
  const totalSizeBytes = largeFileSizeMB * 1024 * 1024;

  await t.step("Cleanup bucket if exists", async () => {
    await deleteBucketIfExists(s3, containerName);
  });

  await t.step("Create Bucket", async () => {
    const result = await s3.send(
      new CreateBucketCommand({
        Bucket: containerName,
      }),
    );
    assertEquals(result.$metadata.httpStatusCode, 200);

    // Create empty index.json file for multipart uploads
    // This is a Swift-specific requirement for the Herald backend
    const createIndexResult = await s3.send(
      new PutObjectCommand({
        Bucket: containerName,
        Key: multipartIndexPath,
        Body: JSON.stringify({
          lastUpdated: new Date().toISOString(),
          uploads: [],
        }),
        ContentType: "application/json",
      }),
    );
    assertEquals(createIndexResult.$metadata.httpStatusCode, 200);
  });

  let uploadId = "";

  await t.step("Initiate Multipart Upload", async () => {
    const result = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: containerName,
        Key: largeObjectKey,
      }),
    );

    assert(result.UploadId);
    uploadId = result.UploadId!;
    assertEquals(result.Key, largeObjectKey);
  });

  let tempFilePath: string | undefined;
  const uploadedParts: { PartNumber: number; ETag: string }[] = [];

  await t.step("Create large temp file", async () => {
    // createTempFile utility creates a file of specified size in bytes
    tempFilePath = await createTempFile(largeFileSizeMB);
    const fileInfo = await Deno.stat(tempFilePath);
    assertEquals(fileInfo.size, totalSizeBytes);
  });

  await t.step("Upload Parts", async () => {
    if (!tempFilePath) throw new Error("Temp file not created");

    const file = await Deno.open(tempFilePath, { read: true });
    let uploadedSize = 0;
    let partNumber = 1;

    while (uploadedSize < totalSizeBytes) {
      const buffer = new Uint8Array(partSize);
      // Read up to `partSize` bytes into the buffer
      const bytesRead = await file.read(buffer);

      if (bytesRead === null) {
        // Should only happen if totalSize was 0 or we finished reading
        break;
      }

      const partBody = buffer.subarray(0, bytesRead);

      const result = await s3.send(
        new UploadPartCommand({
          Bucket: containerName,
          Key: largeObjectKey,
          PartNumber: partNumber,
          UploadId: uploadId,
          Body: partBody,
        }),
      );

      assert(result.ETag);
      uploadedParts.push({ PartNumber: partNumber, ETag: result.ETag! });

      uploadedSize += bytesRead;
      partNumber++;
    }

    // Close the file handle
    file.close();
  });

  await t.step("List Parts", async () => {
    const result = await s3.send(
      new ListPartsCommand({
        Bucket: containerName,
        Key: largeObjectKey,
        UploadId: uploadId,
      }),
    );

    assert(result.Parts);
    assertEquals(result.Parts.length, uploadedParts.length);

    // Verify part numbers and ETags match
    for (const uploadedPart of uploadedParts) {
      const listedPart = result.Parts.find((p) =>
        p.PartNumber === uploadedPart.PartNumber
      );
      assert(listedPart);
      assertEquals(listedPart.ETag, uploadedPart.ETag);
      // Optional: check size if available in ListParts response (it is)
      // Need to store chunk sizes during upload if we want to verify size here
      // For now, just verifying count, number, and ETag is sufficient.
    }
  });

  await t.step("Complete Multipart Upload", async () => {
    const result = await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: containerName,
        Key: largeObjectKey,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: uploadedParts, // Provide the list of parts with ETag and PartNumber
        },
      }),
    );

    assertEquals(result.$metadata.httpStatusCode, 200);
    assert(result.ETag); // The ETag of the completed object
    assertEquals(result.Key, largeObjectKey);
    assertEquals(result.Bucket, containerName);
  });

  await t.step("Verify Object Exists", async () => {
    const headObject = new HeadObjectCommand({
      Bucket: containerName,
      Key: largeObjectKey,
    });
    const res = await s3.send(headObject);
    // checkHeadObject utility checks for 200 status and other properties
    checkHeadObject(res);
    // Verify Content-Length matches the total size
    assertEquals(res.ContentLength, totalSizeBytes);
  });

  await t.step("Wait for sync time", async () => {
    // sleep and wait for the mirror to sync
    await new Promise((r) => setTimeout(r, SYNC_WAIT));
  });

  await t.step("Cleanup Bucket", async () => {
    await deleteBucketIfExists(s3, containerName);
    // Clean up the temporary file
    if (tempFilePath) {
      await Deno.remove(tempFilePath);
    }
  });
};

Deno.test("Multipart Upload Flow (Large File)", async (t) => {
  await testMPULargeFile(t, containerName);
});

Deno.test("Multipart Upload Flow (Large File) -- on S3 REPLICA", async (t) => {
  await testMPULargeFile(t, "swift-mirror-test");
});
