import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256";
import { harness, type ProxyTestCase } from "../utils.ts";
import type { GlobalConfig } from "../../src/Domain/Config.ts";

const testConfig: GlobalConfig = {
  backends: {
    minio: {
      protocol: "s3",
      endpoint: "http://localhost:9000",
      region: "us-east-1",
      credentials: {
        accessKeyId: "minioadmin",
        secretAccessKey: "minioadmin",
      },
      buckets: "*",
    },
  },
};

const BUCKET = "test-aws-chunked-put-bucket";
const KEY = "aws-chunked-object.txt";
const MULTIPART_KEY = "aws-chunked-multipart-object.txt";
const PLAINTEXT = "hello world";
const CHUNKED_PAYLOAD =
  "b;chunk-signature=abc\r\nhello world\r\n0;chunk-signature=def\r\n\r\n";

const credentials = {
  accessKeyId: "minioadmin",
  secretAccessKey: "minioadmin",
};

async function sendAwsChunkedPut(baseUrl: string): Promise<Response> {
  const url = new URL(`${baseUrl}/${BUCKET}/${KEY}`);
  const body = new TextEncoder().encode(CHUNKED_PAYLOAD);
  const signer = new SignatureV4({
    credentials,
    region: "us-east-1",
    service: "s3",
    sha256: Sha256,
  });

  const signed = await signer.sign({
    method: "PUT",
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port === "" ? undefined : parseInt(url.port, 10),
    path: url.pathname,
    query: {},
    headers: {
      "content-encoding": "aws-chunked",
      "content-length": String(body.length),
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
      "x-amz-decoded-content-length": String(PLAINTEXT.length),
    },
    body,
  });

  const requestHeaders = new Headers();
  for (const [key, value] of Object.entries(signed.headers)) {
    if (key.toLowerCase() === "host") {
      continue;
    }
    requestHeaders.set(key, value);
  }

  return await fetch(url, {
    method: "PUT",
    headers: requestHeaders,
    body,
    // @ts-ignore duplex is required for non-GET body in Deno fetch with streams/body bytes
    duplex: "half",
  });
}

async function sendAwsChunkedUploadPart(
  baseUrl: string,
  uploadId: string,
): Promise<Response> {
  const url = new URL(`${baseUrl}/${BUCKET}/${MULTIPART_KEY}`);
  url.searchParams.set("partNumber", "1");
  url.searchParams.set("uploadId", uploadId);

  const body = new TextEncoder().encode(CHUNKED_PAYLOAD);
  const signer = new SignatureV4({
    credentials,
    region: "us-east-1",
    service: "s3",
    sha256: Sha256,
  });

  const signed = await signer.sign({
    method: "PUT",
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port === "" ? undefined : parseInt(url.port, 10),
    path: url.pathname,
    query: {
      partNumber: "1",
      uploadId,
    },
    headers: {
      "content-encoding": "aws-chunked",
      "content-length": String(body.length),
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
      "x-amz-decoded-content-length": String(PLAINTEXT.length),
    },
    body,
  });

  const requestHeaders = new Headers();
  for (const [key, value] of Object.entries(signed.headers)) {
    if (key.toLowerCase() === "host") {
      continue;
    }
    requestHeaders.set(key, value);
  }

  return await fetch(url, {
    method: "PUT",
    headers: requestHeaders,
    body,
    // @ts-ignore duplex is required for non-GET body in Deno fetch with streams/body bytes
    duplex: "half",
  });
}

async function verifyStoredBody(client: S3Client): Promise<void> {
  const out = await client.send(
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: KEY,
    }),
  );

  const bytes = await out.Body?.transformToByteArray();
  if (!bytes) {
    throw new Error("Expected object body");
  }
  const text = new TextDecoder().decode(bytes);
  if (text !== PLAINTEXT) {
    throw new Error(
      `Decoded payload mismatch; expected "${PLAINTEXT}", got "${
        text.slice(0, 120)
      }"`,
    );
  }
}

const cases: ProxyTestCase[] = [{
  name: "objects/put/aws-chunked-decoding",
  config: testConfig,
  beforeAll: async (client) => {
    try {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    } catch {
      // Ignore already-exists races.
    }
  },
  fn: async (client, context) => {
    if (!context?.baseUrl) {
      throw new Error("Missing baseUrl in test context");
    }
    const putResponse = await sendAwsChunkedPut(context.baseUrl);
    if (putResponse.status !== 200) {
      const body = await putResponse.text();
      throw new Error(
        `aws-chunked PUT failed: status=${putResponse.status} body=${
          body.slice(0, 200)
        }`,
      );
    }
    await verifyStoredBody(client);
  },
  afterAll: async (client) => {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: KEY }));
    } catch {
      // Ignore cleanup failures.
    }
    try {
      await client.send(new DeleteBucketCommand({ Bucket: BUCKET }));
    } catch {
      // Ignore cleanup failures.
    }
  },
  ignoreBaseline: true,
  skipSnapshot: true,
}, {
  name: "objects/multipart/aws-chunked-uploadpart-decoding",
  config: testConfig,
  beforeAll: async (client) => {
    try {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    } catch {
      // Ignore already-exists races.
    }
  },
  fn: async (client, context) => {
    if (!context?.baseUrl) {
      throw new Error("Missing baseUrl in test context");
    }

    const { UploadId } = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: BUCKET,
        Key: MULTIPART_KEY,
      }),
    );
    if (!UploadId) {
      throw new Error("Expected UploadId");
    }

    const uploadPartResponse = await sendAwsChunkedUploadPart(
      context.baseUrl,
      UploadId,
    );
    if (uploadPartResponse.status !== 200) {
      const body = await uploadPartResponse.text();
      throw new Error(
        `aws-chunked UploadPart failed: status=${uploadPartResponse.status} body=${
          body.slice(0, 200)
        }`,
      );
    }

    const etag = uploadPartResponse.headers.get("etag");
    if (!etag) {
      throw new Error("UploadPart response did not include ETag header");
    }

    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: BUCKET,
        Key: MULTIPART_KEY,
        UploadId,
        MultipartUpload: {
          Parts: [{
            PartNumber: 1,
            ETag: etag,
          }],
        },
      }),
    );

    const out = await client.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: MULTIPART_KEY,
      }),
    );
    const bytes = await out.Body?.transformToByteArray();
    if (!bytes) {
      throw new Error("Expected multipart object body");
    }
    const text = new TextDecoder().decode(bytes);
    if (text !== PLAINTEXT) {
      throw new Error(
        `Multipart decoded payload mismatch; expected "${PLAINTEXT}", got "${
          text.slice(0, 120)
        }"`,
      );
    }
  },
  afterAll: async (client) => {
    try {
      await client.send(
        new DeleteObjectCommand({ Bucket: BUCKET, Key: MULTIPART_KEY }),
      );
    } catch {
      // Ignore cleanup failures.
    }
    try {
      await client.send(new DeleteBucketCommand({ Bucket: BUCKET }));
    } catch {
      // Ignore cleanup failures.
    }
  },
  ignoreBaseline: true,
  skipSnapshot: true,
}];

harness(cases);
