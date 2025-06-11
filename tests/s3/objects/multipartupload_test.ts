import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
  Part,
  UploadPartCommand,
} from "aws-sdk/client-s3";
import { assert, assertEquals } from "std/assert";
import { createTempFile } from "../../../utils/file.ts";
import {
  checkHeadObject,
  deleteBucketIfExists,
  getS3Client,
} from "../../../utils/s3.ts";
import { SYNC_WAIT } from "../../mirror/mod.ts";
import { testTempDir } from "../../utils/mod.ts";

const bucket = "s3-test";

const s3 = getS3Client({
  credentials: {
    accessKeyId: "minio",
    secretAccessKey: "password",
  },
  region: "local",
  forcePathStyle: true,
  endpoint: "http://localhost:8000",
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
      const listedPart = result.Parts.find((p: Part) =>
        // Add type annotation for 'p'
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
    // This step is relevant if testing mirroring scenarios where the S3 interface
    // is used but data needs to sync to another backend.
    await new Promise((r) => setTimeout(r, SYNC_WAIT));
  });

  await t.step("Cleanup Bucket", async () => {
    await deleteBucketIfExists(s3, containerName);
    // Clean up the temporary file
    await Deno.remove(testTempDir, { recursive: true });
  });
};

Deno.test("Multipart Upload Flow (Large File) -- on SWIFT REPLICA", async (t) => {
  await testMPULargeFile(t, bucket);
});

Deno.test("Multipart Upload Flow (Large File) -- on SWIFT REPLICA", async (t) => {
  await testMPULargeFile(t, "s3-mirror-test");
});
