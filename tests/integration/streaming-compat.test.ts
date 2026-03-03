import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256";
import { assertEquals, harness, type ProxyTestCase } from "../utils.ts";
import type { GlobalConfig } from "../../src/Domain/Config.ts";
import { createHash } from "node-crypto";

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

const BUCKET = "test-streaming-compat-bucket";
const KEY_ENCODING = "encoding.txt";
const KEY_CHUNKED = "chunked-transfer.txt";
const credentials = {
  accessKeyId: "minioadmin",
  secretAccessKey: "minioadmin",
};

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const cleanup = async (client: S3Client) => {
  await Promise.all([KEY_ENCODING, KEY_CHUNKED].map(async (key) => {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    } catch {
      // Ignore cleanup failures.
    }
  }));
  try {
    await client.send(new DeleteBucketCommand({ Bucket: BUCKET }));
  } catch {
    // Ignore cleanup failures.
  }
};

const signedStreamPutWithoutContentLength = async (
  baseUrl: string,
  bucket: string,
  key: string,
  bodyText: string,
): Promise<Response> => {
  const url = new URL(`${baseUrl}/${bucket}/${key}`);
  const bodyBytes = new TextEncoder().encode(bodyText);
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
      "x-amz-content-sha256": sha256Hex(bodyText),
    },
    body: bodyBytes,
  });

  const requestHeaders = new Headers();
  for (const [headerName, headerValue] of Object.entries(signed.headers)) {
    if (headerName.toLowerCase() === "host") {
      continue;
    }
    requestHeaders.set(headerName, headerValue);
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bodyBytes);
      controller.close();
    },
  });

  return await fetch(url, {
    method: "PUT",
    headers: requestHeaders,
    body: stream,
    // @ts-ignore required by fetch implementations for streaming request body
    duplex: "half",
  });
};

const signedPutWithHeaders = async (
  baseUrl: string,
  bucket: string,
  key: string,
  bodyText: string,
  headers: Record<string, string>,
): Promise<Response> => {
  const url = new URL(`${baseUrl}/${bucket}/${key}`);
  const bodyBytes = new TextEncoder().encode(bodyText);
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
      ...headers,
      "x-amz-content-sha256": sha256Hex(bodyText),
      "content-length": String(bodyBytes.length),
    },
    body: bodyBytes,
  });

  const requestHeaders = new Headers();
  for (const [headerName, headerValue] of Object.entries(signed.headers)) {
    if (headerName.toLowerCase() === "host") {
      continue;
    }
    requestHeaders.set(headerName, headerValue);
  }

  return await fetch(url, {
    method: "PUT",
    headers: requestHeaders,
    body: bodyBytes,
    // @ts-ignore duplex is required for non-GET body in Deno fetch with streams/body bytes
    duplex: "half",
  });
};

const cases: ProxyTestCase[] = [
  {
    name: "streaming/content-encoding/aws-chunked-stripped",
    config: testConfig,
    beforeAll: async (client) => {
      try {
        await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
      } catch {
        // Ignore already-exists races.
      }
    },
    fn: async (_client, context) => {
      if (!context?.baseUrl) {
        throw new Error("Missing baseUrl in test context");
      }
      const putResponse = await signedPutWithHeaders(
        context.baseUrl,
        BUCKET,
        KEY_ENCODING,
        "hello",
        {
          "content-encoding": "aws-chunked",
        },
      );
      assertEquals(putResponse.status, 200);
    },
    afterAll: cleanup,
    ignoreBaseline: true,
    skipSnapshot: true,
  },
  {
    name: "streaming/put/chunked-transfer-without-content-length",
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
      const response = await signedStreamPutWithoutContentLength(
        context.baseUrl,
        BUCKET,
        KEY_CHUNKED,
        "bar",
      );
      assertEquals(response.status, 200);

      const out = await client.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: KEY_CHUNKED }),
      );
      const bytes = await out.Body?.transformToByteArray();
      assertEquals(new TextDecoder().decode(bytes ?? new Uint8Array(0)), "bar");
    },
    afterAll: cleanup,
    ignoreBaseline: true,
    skipSnapshot: true,
  },
];

harness(cases);
