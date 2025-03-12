import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
  S3ClientConfig,
  ServiceOutputTypes,
} from "aws-sdk/client-s3";
import { assert, assertEquals } from "std/assert";

export function getS3Client(config: S3ClientConfig) {
  // deno-lint-ignore require-await no-explicit-any
  const loggingMiddleware = (next: any) => async (args: any) => {
    const { request } = args;
    // deno-lint-ignore no-console
    console.log("Request Details:", {
      url:
        `${request.protocol}//${request.hostname}:${request.port}${request.path}`,
      method: request.method,
      hostname: request.hostname,
      path: request.path,
      headers: request.headers,
    });
    return next(args);
  };

  const s3 = new S3Client({
    ...config,
  });
  const envVar = Deno.env.get("log_level");
  const debug = envVar === "DEBUG";
  if (debug) {
    s3.middlewareStack.add(loggingMiddleware, {
      step: "finalizeRequest",
    });
  }

  return s3;
}

export async function deleteBucketIfExists(
  client: S3Client,
  bucketName: string,
) {
  while (true) {
    const list = await listObjects(client, bucketName);
    if (list == null) {
      return;
    }
    if (list.length === 0) {
      break;
    }

    for (const { Key } of list) {
      await client.send(
        new DeleteObjectCommand({ Bucket: bucketName, Key: Key! }),
      );
    }
  }

  const deleteCommand = new DeleteBucketCommand({ Bucket: bucketName });
  await client.send(deleteCommand);
}

export async function listObjects(client: S3Client, bucketName: string) {
  try {
    const listCommand = new ListObjectsV2Command({
      Bucket: bucketName,
    });
    const res = await client.send(listCommand);
    return res.Contents ?? [];
  } catch (e) {
    if ((e as Error).name === "NoSuchBucket") {
      return null;
    }
    throw e;
  }
}

export async function setupBucket(client: S3Client, bucketName: string) {
  await deleteBucketIfExists(client, bucketName);
  const createBucket = new CreateBucketCommand({
    Bucket: bucketName,
  });
  await client.send(createBucket);
}

export function checkPutObject(res: ServiceOutputTypes) {
  const actual = res.$metadata.httpStatusCode;
  const expected = [200, 201]; // Allowed values

  assert(actual !== undefined && expected.includes(actual));
}

export function checkDeleteObject(res: ServiceOutputTypes) {
  assertEquals(res.$metadata.httpStatusCode, 204);
}

export function checkUpload(res: ServiceOutputTypes) {
  assertEquals(res.$metadata.httpStatusCode, 200);
}

export function checkCreateBucket(res: ServiceOutputTypes) {
  const actual = res.$metadata.httpStatusCode;
  const expected = [200, 201]; // Allowed values

  assert(actual !== undefined && expected.includes(actual));
}

export function checkDeleteBucket(res: ServiceOutputTypes) {
  assertEquals(res.$metadata.httpStatusCode, 204);
}

export function checkListObjects(res: ServiceOutputTypes) {
  assertEquals(res.$metadata.httpStatusCode, 200);
}

export function checkGetObject(res: ServiceOutputTypes) {
  assertEquals(res.$metadata.httpStatusCode, 200);
}

export function checkHeadObject(res: ServiceOutputTypes) {
  assertEquals(res.$metadata.httpStatusCode, 200);
}

export function checkCopyObject(res: ServiceOutputTypes) {
  const actual = res.$metadata.httpStatusCode;
  const expected = [200, 201]; // Allowed values

  assert(actual !== undefined && expected.includes(actual));
}

export async function createBucketWithoutSDK(
  endpoint: string,
  bucketName: string,
  region: string,
  accessKeyId: string,
) {
  const url = `${endpoint}/${bucketName}`;
  const date = new Date().toUTCString();
  const payload = `<?xml version="1.0" encoding="UTF-8"?>
<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <LocationConstraint>local</LocationConstraint>
</CreateBucketConfiguration>`;

  const headers = {
    "content-type": "text/plain;charset=UTF-8",
    "Host": new URL(url).host,
    "x-amz-date": new Date().toISOString().replace(/[:-]/g, "").replace(
      /\.\d{3}Z$/,
      "Z",
    ),
    "Authorization": `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${
      date.slice(12, 22)
    }/${region}/s3/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=`,
    "content-length": "0",
    "x-amz-content-sha256":
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "accept-encoding": "identity",
    "amz-sdk-invocation-id": "d6503e2b-eaae-434e-9abf-b64f24f3570c",
    "amz-sdk-request": "attempt=1",
  };

  const response = await fetch(url, {
    method: "PUT",
    headers: headers,
    body: payload,
  });

  if (!response.ok) {
    throw new Error(`Failed to create bucket: ${response.statusText}`);
  }

  return response;
}
