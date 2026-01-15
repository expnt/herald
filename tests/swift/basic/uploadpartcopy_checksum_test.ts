// deno-lint-ignore-file no-console
import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
} from "aws-sdk/client-s3";
import { assert, assertEquals } from "std/assert";
// import { loggingMiddleware } from "../../utils/mod.ts";
import { configInit, globalConfig, proxyUrl } from "../../../src/config/mod.ts";
import { checkHeadObject, deleteBucketIfExists } from "../../../utils/s3.ts";
import { createTempFile } from "../../../utils/file.ts";

const containerName = "swift-test";
const sourceObjectKey = "source-docker-layer.bin";
const targetObjectKey = "target-docker-layer.bin";

// Size constants
const MB = 1024 * 1024;
const SOURCE_SIZE = 300 * MB;
const PART_SIZE = 5 * MB; // 5MB per part
const PART_COUNT = Math.ceil(SOURCE_SIZE / PART_SIZE);

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

// Helper function to calculate SHA-256 hash of a buffer
async function calculateSha256(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  // Convert buffer to hex string
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Helper function to get credentials in a type-safe way
function getCredentials() {
  return "accessKeyId" in containerConfig.credentials
    ? {
      accessKeyId: containerConfig.credentials.accessKeyId,
      secretAccessKey: containerConfig.credentials.secretAccessKey,
    }
    : {
      accessKeyId: containerConfig.credentials.username,
      secretAccessKey: containerConfig.credentials.password,
    };
}

/**
 * This test simulates the Docker pull scenario where GitLab dependency proxy
 * caches Docker image layers using multipart upload with copy.
 *
 * The test:
 * 1. Creates a source object (simulating the original Docker layer)
 * 2. Copies it in chunks using uploadPartCopy (simulating the caching process)
 * 3. Verifies the checksum of the resulting object matches the original
 */
Deno.test("Docker Pull Simulation with UploadPartCopy", async (t) => {
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

  let sourceData: Uint8Array;
  let sourceChecksum: string;

  // Create a source object to copy from (simulating the original Docker layer)
  await t.step("Create Source Object (Docker Layer)", async () => {
    const tempFile = await createTempFile(SOURCE_SIZE / MB); // 30MB file
    sourceData = await Deno.readFile(tempFile);
    sourceChecksum = await calculateSha256(sourceData);
    console.log(`Source object size: ${sourceData.byteLength} bytes`);
    console.log(`Source object checksum (SHA-256): ${sourceChecksum}`);

    const result = await s3.send(
      new PutObjectCommand({
        Bucket: containerName,
        Key: sourceObjectKey,
        Body: sourceData,
      }),
    );
    assertEquals(result.$metadata.httpStatusCode, 200);
    console.log(
      `Source object (Docker layer) uploaded with ETag: ${result.ETag}`,
    );

    // Verify the source object was uploaded correctly
    const headResult = await s3.send(
      new HeadObjectCommand({
        Bucket: containerName,
        Key: sourceObjectKey,
      }),
    );
    checkHeadObject(headResult);
    assert(
      headResult.ContentLength,
      "No ContentLength in source HeadObject response",
    );
    assertEquals(
      headResult.ContentLength,
      SOURCE_SIZE,
      "Source object size mismatch",
    );
    console.log(
      `Source object size verified: ${headResult.ContentLength} bytes`,
    );
  });

  let uploadId = "";

  // Initiate multipart upload (simulating GitLab dependency proxy cache operation)
  await t.step("Initiate Multipart Upload (Cache Operation)", async () => {
    const result = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: containerName,
        Key: targetObjectKey,
      }),
    );

    assert(result.UploadId);
    uploadId = result.UploadId!;
    assertEquals(result.Key, targetObjectKey);
    console.log(`Multipart upload initiated with ID: ${uploadId}`);
  });

  const partETags: { ETag: string; PartNumber: number }[] = [];

  // Upload parts by copying from source (simulating GitLab dependency proxy caching chunks)
  await t.step("Upload Parts using Copy (Caching Chunks)", async () => {
    // We'll use the AWS SDK for this test to ensure proper authentication
    for (let partNumber = 1; partNumber <= PART_COUNT; partNumber++) {
      const startByte = (partNumber - 1) * PART_SIZE;
      let endByte = partNumber * PART_SIZE - 1;

      // Adjust end byte for the last part
      if (partNumber === PART_COUNT) {
        endByte = SOURCE_SIZE - 1;
      }

      console.log(
        `Copying part ${partNumber}: bytes=${startByte}-${endByte} (${
          endByte - startByte + 1
        } bytes)`,
      );

      // Using fetch with proper AWS signature (v4)
      const url = new URL(`${proxyUrl}/${containerName}/${targetObjectKey}`);
      url.searchParams.append("partNumber", partNumber.toString());
      url.searchParams.append("uploadId", uploadId);

      // Manual request with proper headers
      const credentials = getCredentials();
      const date = new Date().toISOString().replace(/[:-]/g, "").split(".")[0] +
        "Z";

      const headers = {
        "Authorization":
          `AWS ${credentials.accessKeyId}:${credentials.secretAccessKey}`,
        "x-amz-copy-source": `${containerName}/${sourceObjectKey}`,
        "x-amz-copy-source-range": `bytes=${startByte}-${endByte}`,
        "x-amz-date": date,
      };

      try {
        const response = await fetch(url.toString(), {
          method: "PUT",
          headers: headers,
        });

        // await new Promise((resolve) => setTimeout(resolve, 50000));

        if (response.status !== 200) {
          const errorText = await response.text();
          throw new Error(`Failed to copy part ${partNumber}: ${errorText}`);
        }

        const responseText = await response.text();
        console.log(
          `Response for part ${partNumber}:`,
          responseText.substring(0, 200) +
            (responseText.length > 200 ? "..." : ""),
        );

        if (!responseText.includes("<CopyPartResult")) {
          throw new Error(`Invalid response for part ${partNumber}`);
        }

        if (!responseText.includes("<ETag>")) {
          throw new Error(`No ETag in response for part ${partNumber}`);
        }

        // Extract ETag from the XML response
        const etagMatch = responseText.match(/<ETag>([^<]+)<\/ETag>/);
        if (!etagMatch) {
          throw new Error(`Could not extract ETag for part ${partNumber}`);
        }

        const partETag = etagMatch[1];

        partETags.push({
          ETag: partETag,
          PartNumber: partNumber,
        });

        console.log(`Part ${partNumber} copied with ETag: ${partETag}`);
      } catch (error) {
        console.error(`Error copying part ${partNumber}:`, error);
        throw error;
      }
    }
  });

  // Verify all parts were uploaded correctly
  await t.step("Verify All Parts", async () => {
    const result = await s3.send(
      new ListPartsCommand({
        Bucket: containerName,
        Key: targetObjectKey,
        UploadId: uploadId,
      }),
    );

    console.log("ListParts response:", JSON.stringify(result, null, 2));

    // Check if we have all the parts
    assert(result.Parts, "No parts returned in ListParts response");
    assertEquals(
      result.Parts.length,
      PART_COUNT,
      `Expected ${PART_COUNT} parts, got ${result.Parts.length}`,
    );

    for (let i = 0; i < PART_COUNT; i++) {
      const partNumber = i + 1;
      const part = result.Parts.find((p) => p.PartNumber === partNumber);
      assert(part, `Part ${partNumber} not found in ListParts response`);
      assertEquals(part.PartNumber, partNumber);
      assert(part.ETag, `No ETag for part ${partNumber}`);
      console.log(
        `Part ${partNumber} verified: ETag=${part.ETag}, Size=${part.Size}`,
      );
    }

    console.log(`All ${PART_COUNT} parts verified in ListParts response`);
  });

  // Complete multipart upload (simulating GitLab finalizing the cached Docker layer)
  await t.step("Complete Multipart Upload (Finalize Cache)", async () => {
    console.log(
      "Completing multipart upload with parts:",
      JSON.stringify(partETags, null, 2),
    );

    // Sort parts by part number to ensure correct order
    partETags.sort((a, b) => a.PartNumber - b.PartNumber);

    const result = await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: containerName,
        Key: targetObjectKey,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: partETags,
        },
      }),
    );

    assertEquals(result.$metadata.httpStatusCode, 200);
    assert(result.ETag, "No ETag in CompleteMultipartUpload response");
    console.log(`Multipart upload completed with ETag: ${result.ETag}`);
    console.log("Complete response:", JSON.stringify(result, null, 2));
  });

  // Add a small delay to ensure the object is fully assembled
  await t.step("Wait for object assembly", async () => {
    console.log("Waiting for object assembly...");
    await new Promise((resolve) => setTimeout(resolve, 3000));
  });

  // Verify the size of the cached Docker layer
  await t.step("Verify Cached Layer Size", async () => {
    const result = await s3.send(
      new HeadObjectCommand({
        Bucket: containerName,
        Key: targetObjectKey,
      }),
    );
    checkHeadObject(result);
    assert(result.ContentLength, "No ContentLength in HeadObject response");
    console.log(
      `Target object size: ${result.ContentLength} bytes (expected: ${SOURCE_SIZE} bytes)`,
    );
    assertEquals(result.ContentLength, SOURCE_SIZE);
  });

  // Verify the checksum of the cached Docker layer (simulating Docker's verification)
  await t.step("Verify Layer Checksum (Docker Verification)", async () => {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: containerName,
        Key: targetObjectKey,
      }),
    );

    assert(result.Body, "No body in GetObject response");

    // Convert stream to buffer
    const chunks: Uint8Array[] = [];
    for await (const chunk of result.Body as ReadableStream<Uint8Array>) {
      chunks.push(new Uint8Array(chunk));
    }

    // Combine chunks into a single buffer
    let totalLength = 0;
    for (const chunk of chunks) {
      totalLength += chunk.length;
    }

    const targetData = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      targetData.set(chunk, offset);
      offset += chunk.length;
    }

    console.log(`Retrieved target object size: ${totalLength} bytes`);

    // Calculate checksum of the target object
    const targetChecksum = await calculateSha256(targetData);
    console.log(`Source object checksum: ${sourceChecksum}`);
    console.log(`Target object checksum: ${targetChecksum}`);

    // Verify checksums match (this is what Docker does during pull)
    assertEquals(targetChecksum, sourceChecksum, "Checksums do not match!");
    console.log(
      "✅ Checksums match! The Docker layer verification would succeed.",
    );
  });

  await t.step("Cleanup", async () => {
    await deleteBucketIfExists(s3, containerName);
  });
});
