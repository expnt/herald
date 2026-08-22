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
import { createHash, createHmac } from "node-crypto";
import { harness, type ProxyTestCase } from "../utils.ts";
import type { GlobalConfig } from "../../src/Domain/Config.ts";

const testConfig: GlobalConfig = {
  backends: {
    rustfs: {
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
const KOPIA_KEY = "kopia.blobcfg";
const MULTIPART_KEY = "aws-chunked-multipart-object.txt";
const PLAINTEXT = "hello world";
const KOPIA_PLAINTEXT = "123456789012345678901234567890";
const CHUNKED_PAYLOAD =
  "b;chunk-signature=abc\r\nhello world\r\n0;chunk-signature=def\r\n\r\n";
const EMPTY_SHA256_HEX =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const credentials = {
  accessKeyId: "minioadmin",
  secretAccessKey: "minioadmin",
};

type SigV4StreamingMode = "with-content-encoding" | "streaming-sha256-only";

function awsChunkedHeaders(
  mode: SigV4StreamingMode,
  contentLength?: number,
): Record<string, string> {
  if (mode === "streaming-sha256-only") {
    const headers: Record<string, string> = {
      "x-amz-content-sha256": "STREAMING-AWS4-HMAC-SHA256-PAYLOAD",
      "x-amz-decoded-content-length": String(PLAINTEXT.length),
    };
    if (contentLength !== undefined) {
      headers["content-length"] = String(contentLength);
    }
    return headers;
  }
  return {
    "content-encoding": "aws-chunked",
    ...(contentLength === undefined
      ? {}
      : { "content-length": String(contentLength) }),
    "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    "x-amz-decoded-content-length": String(PLAINTEXT.length),
  };
}

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const hmacHex = (
  key: Uint8Array<ArrayBufferLike>,
  value: string,
): string => createHmac("sha256", key).update(value, "utf8").digest("hex");

function deriveSigningKey(
  secretAccessKey: string,
  scopeDate: string,
  scopeRegion: string,
  scopeService: string,
): Uint8Array<ArrayBufferLike> {
  const kDate = createHmac("sha256", `AWS4${secretAccessKey}`)
    .update(scopeDate, "utf8").digest();
  const kRegion = createHmac("sha256", kDate).update(scopeRegion, "utf8")
    .digest();
  const kService = createHmac("sha256", kRegion).update(scopeService, "utf8")
    .digest();
  return createHmac("sha256", kService).update("aws4_request", "utf8").digest();
}

function parseAuthorizationHeader(
  authorization: string,
): {
  scopeDate: string;
  scopeRegion: string;
  scopeService: string;
  initialSignature: string;
} {
  const credentialMatch = authorization.match(/Credential=([^, ]+)/);
  if (!credentialMatch || !credentialMatch[1]) {
    throw new Error("Missing Credential in Authorization header");
  }
  const parts = credentialMatch[1].split("/");
  if (parts.length < 5) {
    throw new Error("Malformed Credential scope in Authorization header");
  }
  const signatureMatch = authorization.match(/Signature=([0-9a-fA-F]+)/);
  if (!signatureMatch || !signatureMatch[1]) {
    throw new Error("Missing Signature in Authorization header");
  }
  return {
    scopeDate: parts[1],
    scopeRegion: parts[2],
    scopeService: parts[3],
    initialSignature: signatureMatch[1].toLowerCase(),
  };
}

function buildStreamingSigV4Payload(
  plaintext: string,
  amzDate: string,
  scopeDate: string,
  scopeRegion: string,
  scopeService: string,
  initialSignature: string,
): string {
  const signingKey = deriveSigningKey(
    credentials.secretAccessKey,
    scopeDate,
    scopeRegion,
    scopeService,
  );
  const scope = `${scopeDate}/${scopeRegion}/${scopeService}/aws4_request`;
  const chunkHash = sha256Hex(plaintext);
  const chunkStringToSign =
    `AWS4-HMAC-SHA256-PAYLOAD\n${amzDate}\n${scope}\n${initialSignature}\n${EMPTY_SHA256_HEX}\n${chunkHash}`;
  const chunkSignature = hmacHex(signingKey, chunkStringToSign);

  const finalChunkStringToSign =
    `AWS4-HMAC-SHA256-PAYLOAD\n${amzDate}\n${scope}\n${chunkSignature}\n${EMPTY_SHA256_HEX}\n${EMPTY_SHA256_HEX}`;
  const finalChunkSignature = hmacHex(signingKey, finalChunkStringToSign);

  const sizeHex = plaintext.length.toString(16);
  return `${sizeHex};chunk-signature=${chunkSignature}\r\n${plaintext}\r\n0;chunk-signature=${finalChunkSignature}\r\n\r\n`;
}

async function sendAwsChunkedPut(
  baseUrl: string,
  mode: SigV4StreamingMode = "with-content-encoding",
): Promise<Response> {
  const url = new URL(`${baseUrl}/${BUCKET}/${KEY}`);
  const signer = new SignatureV4({
    credentials,
    region: "us-east-1",
    service: "s3",
    sha256: Sha256,
  });

  let body = new TextEncoder().encode(CHUNKED_PAYLOAD);
  let signed = await signer.sign({
    method: "PUT",
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port === "" ? undefined : parseInt(url.port, 10),
    path: url.pathname,
    query: {},
    headers: awsChunkedHeaders(mode, body.length),
    body,
  });

  if (mode === "streaming-sha256-only") {
    const authorization = signed.headers["authorization"];
    const amzDate = signed.headers["x-amz-date"];
    if (!authorization || !amzDate) {
      throw new Error("Expected Authorization and x-amz-date for SigV4");
    }
    const auth = parseAuthorizationHeader(authorization);
    const payload = buildStreamingSigV4Payload(
      PLAINTEXT,
      amzDate,
      auth.scopeDate,
      auth.scopeRegion,
      auth.scopeService,
      auth.initialSignature,
    );
    body = new TextEncoder().encode(payload);
    signed = await signer.sign({
      method: "PUT",
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port === "" ? undefined : parseInt(url.port, 10),
      path: url.pathname,
      query: {},
      headers: awsChunkedHeaders(mode, body.length),
      body,
    });
    const authorization2 = signed.headers["authorization"];
    const amzDate2 = signed.headers["x-amz-date"];
    if (!authorization2 || !amzDate2) {
      throw new Error("Expected Authorization and x-amz-date for SigV4");
    }
    const auth2 = parseAuthorizationHeader(authorization2);
    const payload2 = buildStreamingSigV4Payload(
      PLAINTEXT,
      amzDate2,
      auth2.scopeDate,
      auth2.scopeRegion,
      auth2.scopeService,
      auth2.initialSignature,
    );
    body = new TextEncoder().encode(payload2);
  }

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
    // @ts-expect-error duplex is required for non-GET body in Deno fetch with streams/body bytes
    duplex: "half",
  });
}

async function sendAwsChunkedUploadPart(
  baseUrl: string,
  uploadId: string,
  mode: SigV4StreamingMode = "with-content-encoding",
): Promise<Response> {
  const url = new URL(`${baseUrl}/${BUCKET}/${MULTIPART_KEY}`);
  url.searchParams.set("partNumber", "1");
  url.searchParams.set("uploadId", uploadId);

  const signer = new SignatureV4({
    credentials,
    region: "us-east-1",
    service: "s3",
    sha256: Sha256,
  });

  let body = new TextEncoder().encode(CHUNKED_PAYLOAD);
  let signed = await signer.sign({
    method: "PUT",
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port === "" ? undefined : parseInt(url.port, 10),
    path: url.pathname,
    query: {
      partNumber: "1",
      uploadId,
    },
    headers: awsChunkedHeaders(mode, body.length),
    body,
  });

  if (mode === "streaming-sha256-only") {
    const authorization = signed.headers["authorization"];
    const amzDate = signed.headers["x-amz-date"];
    if (!authorization || !amzDate) {
      throw new Error("Expected Authorization and x-amz-date for SigV4");
    }
    const auth = parseAuthorizationHeader(authorization);
    const payload = buildStreamingSigV4Payload(
      PLAINTEXT,
      amzDate,
      auth.scopeDate,
      auth.scopeRegion,
      auth.scopeService,
      auth.initialSignature,
    );
    body = new TextEncoder().encode(payload);
    signed = await signer.sign({
      method: "PUT",
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port === "" ? undefined : parseInt(url.port, 10),
      path: url.pathname,
      query: {
        partNumber: "1",
        uploadId,
      },
      headers: awsChunkedHeaders(mode, body.length),
      body,
    });
    const authorization2 = signed.headers["authorization"];
    const amzDate2 = signed.headers["x-amz-date"];
    if (!authorization2 || !amzDate2) {
      throw new Error("Expected Authorization and x-amz-date for SigV4");
    }
    const auth2 = parseAuthorizationHeader(authorization2);
    const payload2 = buildStreamingSigV4Payload(
      PLAINTEXT,
      amzDate2,
      auth2.scopeDate,
      auth2.scopeRegion,
      auth2.scopeService,
      auth2.initialSignature,
    );
    body = new TextEncoder().encode(payload2);
  }

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
    // @ts-expect-error duplex is required for non-GET body in Deno fetch with streams/body bytes
    duplex: "half",
  });
}

async function sendKopiaStyleStreamingPut(baseUrl: string): Promise<Response> {
  const url = new URL(`${baseUrl}/${BUCKET}/${KOPIA_KEY}`);
  const signer = new SignatureV4({
    credentials,
    region: "us-east-1",
    service: "s3",
    sha256: Sha256,
  });

  let body = new TextEncoder().encode(CHUNKED_PAYLOAD);
  let signed = await signer.sign({
    method: "PUT",
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port === "" ? undefined : parseInt(url.port, 10),
    path: url.pathname,
    query: {},
    headers: {
      "x-amz-content-sha256": "STREAMING-AWS4-HMAC-SHA256-PAYLOAD",
      "x-amz-decoded-content-length": String(KOPIA_PLAINTEXT.length),
      "content-type": "application/x-kopia",
      "content-length": String(body.length),
    },
    body,
  });

  const authorization = signed.headers["authorization"];
  const amzDate = signed.headers["x-amz-date"];
  if (!authorization || !amzDate) {
    throw new Error("Expected Authorization and x-amz-date for SigV4");
  }
  const auth = parseAuthorizationHeader(authorization);
  const payload = buildStreamingSigV4Payload(
    KOPIA_PLAINTEXT,
    amzDate,
    auth.scopeDate,
    auth.scopeRegion,
    auth.scopeService,
    auth.initialSignature,
  );
  body = new TextEncoder().encode(payload);
  signed = await signer.sign({
    method: "PUT",
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port === "" ? undefined : parseInt(url.port, 10),
    path: url.pathname,
    query: {},
    headers: {
      "x-amz-content-sha256": "STREAMING-AWS4-HMAC-SHA256-PAYLOAD",
      "x-amz-decoded-content-length": String(KOPIA_PLAINTEXT.length),
      "content-type": "application/x-kopia",
      "content-length": String(body.length),
    },
    body,
  });

  const authorization2 = signed.headers["authorization"];
  const amzDate2 = signed.headers["x-amz-date"];
  if (!authorization2 || !amzDate2) {
    throw new Error("Expected Authorization and x-amz-date for SigV4");
  }
  const auth2 = parseAuthorizationHeader(authorization2);
  const payload2 = buildStreamingSigV4Payload(
    KOPIA_PLAINTEXT,
    amzDate2,
    auth2.scopeDate,
    auth2.scopeRegion,
    auth2.scopeService,
    auth2.initialSignature,
  );
  body = new TextEncoder().encode(payload2);

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
    // @ts-expect-error duplex is required for non-GET body in Deno fetch with streams/body bytes
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

async function verifyStoredBodyForKey(
  client: S3Client,
  key: string,
  expected: string,
): Promise<void> {
  const out = await client.send(
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
    }),
  );

  const bytes = await out.Body?.transformToByteArray();
  if (!bytes) {
    throw new Error("Expected object body");
  }
  const text = new TextDecoder().decode(bytes);
  if (text !== expected) {
    throw new Error(
      `Decoded payload mismatch for ${key}; expected "${expected}", got "${
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
  name: "objects/put/aws-chunked-decoding/streaming-sha256-header-only",
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
    const putResponse = await sendAwsChunkedPut(
      context.baseUrl,
      "streaming-sha256-only",
    );
    if (putResponse.status !== 200) {
      const body = await putResponse.text();
      throw new Error(
        `aws-chunked PUT (streaming-sha256-only) failed: status=${putResponse.status} body=${
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
  name: "objects/put/aws-chunked-decoding/streaming-sha256-kopia-shape",
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
    const putResponse = await sendKopiaStyleStreamingPut(context.baseUrl);
    if (putResponse.status !== 200) {
      const body = await putResponse.text();
      throw new Error(
        `aws-chunked PUT (kopia-shape) failed: status=${putResponse.status} body=${
          body.slice(0, 200)
        }`,
      );
    }
    await verifyStoredBodyForKey(client, KOPIA_KEY, KOPIA_PLAINTEXT);
  },
  afterAll: async (client) => {
    try {
      await client.send(
        new DeleteObjectCommand({ Bucket: BUCKET, Key: KOPIA_KEY }),
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
}, {
  name:
    "objects/put/aws-chunked-decoding/streaming-sha256-kopia-shape/no-auth-config",
  config: testConfig,
  disableDefaultAuth: true,
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
    const putResponse = await sendKopiaStyleStreamingPut(context.baseUrl);
    if (putResponse.status !== 200) {
      const body = await putResponse.text();
      throw new Error(
        `aws-chunked PUT (kopia-shape no-auth-config) failed: status=${putResponse.status} body=${
          body.slice(0, 200)
        }`,
      );
    }
    await verifyStoredBodyForKey(client, KOPIA_KEY, KOPIA_PLAINTEXT);
  },
  afterAll: async (client) => {
    try {
      await client.send(
        new DeleteObjectCommand({ Bucket: BUCKET, Key: KOPIA_KEY }),
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
}, {
  name:
    "objects/multipart/aws-chunked-uploadpart-decoding/streaming-sha256-header-only",
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
      "streaming-sha256-only",
    );
    if (uploadPartResponse.status !== 200) {
      const body = await uploadPartResponse.text();
      throw new Error(
        `aws-chunked UploadPart (streaming-sha256-only) failed: status=${uploadPartResponse.status} body=${
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
