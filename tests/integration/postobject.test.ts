/**
 * S3 PostObject (POST multipart/form-data with policy + signature) integration
 * tests. Uses the same TDD harness as buckets/objects: Baseline (direct RustFS),
 * Proxy (Herald in front of RustFS), and Swift (Herald in front of Swift).
 *
 * Run: deno test tests/integration/postobject.test.ts --allow-env --allow-net --allow-sys
 */
import { createHash, createHmac } from "node-crypto";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  harness,
  type ProxyTestCase,
  type ProxyTestContext,
} from "../utils.ts";
import type { GlobalConfig } from "../../src/Domain/Config.ts";
import { assertEquals } from "@std/assert";

function sha256Base64(data: Uint8Array | string): string {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return createHash("sha256").update(buf).digest("base64");
}

const BUCKET = "test-postobject-bucket";

const testConfig: GlobalConfig = {
  backends: {
    rustfs: {
      protocol: "s3",
      endpoint: "http://localhost:9100",
      region: "us-east-1",
      credentials: {
        accessKeyId: "minioadmin",
        secretAccessKey: "minioadmin",
      },
      buckets: "*",
    },
  },
};

function buildPolicyAndSignature(
  bucket: string,
  keyPrefix: string,
  contentLengthMax: number,
  _accessKeyId: string,
  secretAccessKey: string,
  extraConditions: unknown[] = [],
): { policy: string; signature: string } {
  const expires = new Date(Date.now() + 6000 * 1000);
  const policyDoc = {
    expiration: expires.toISOString().replace(/\.\d{3}Z$/, "Z"),
    conditions: [
      { bucket },
      ["starts-with", "$key", keyPrefix],
      { acl: "private" },
      ["starts-with", "$Content-Type", "text/plain"],
      ["content-length-range", 0, contentLengthMax],
      ...extraConditions,
    ],
  };
  return buildPolicyFromDoc(policyDoc, secretAccessKey);
}

/** Build policy and signature from an explicit policy document (for custom conditions). */
function buildPolicyFromDoc(
  policyDoc: { expiration: string; conditions: unknown[] },
  secretAccessKey: string,
): { policy: string; signature: string } {
  const policyStr = JSON.stringify(policyDoc);
  const policyB64 = btoa(unescape(encodeURIComponent(policyStr)));
  const signature = createHmac("sha1", secretAccessKey)
    .update(policyB64, "utf8")
    .digest("base64");
  return { policy: policyB64, signature };
}

async function postObjectAuthenticated(
  client: S3Client,
  context: ProxyTestContext,
): Promise<void> {
  const key = "foo.txt";
  const body = "bar";
  const { policy, signature } = buildPolicyAndSignature(
    BUCKET,
    "foo",
    1024,
    "minioadmin",
    "minioadmin",
  );

  const form = new FormData();
  form.append("key", key);
  form.append("AWSAccessKeyId", "minioadmin");
  form.append("acl", "private");
  form.append("signature", signature);
  form.append("policy", policy);
  form.append("Content-Type", "text/plain");
  form.append("file", new Blob([body]), "file.txt");

  const res = await fetch(`${context.baseUrl}/${BUCKET}`, {
    method: "POST",
    body: form,
  });

  const resBody = await res.text();
  assertEquals(
    res.status,
    204,
    `Expected 204 No Content, got ${res.status}. Body: ${
      resBody.slice(0, 800)
    }`,
  );

  const getRes = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
  );
  const gotBody = await getRes.Body?.transformToByteArray() ??
    new Uint8Array(0);
  assertEquals(
    new TextDecoder().decode(gotBody),
    body,
    "Object body should match uploaded content",
  );
}

async function postObjectInvalidSignature(
  _client: S3Client,
  context: ProxyTestContext,
): Promise<void> {
  const key = "foo.txt";
  const { policy } = buildPolicyAndSignature(
    BUCKET,
    "foo",
    1024,
    "minioadmin",
    "minioadmin",
  );

  const form = new FormData();
  form.append("key", key);
  form.append("AWSAccessKeyId", "minioadmin");
  form.append("acl", "private");
  form.append("signature", btoa("wrong-signature"));
  form.append("policy", policy);
  form.append("Content-Type", "text/plain");
  form.append("file", new Blob(["bar"]), "file.txt");

  const res = await fetch(`${context.baseUrl}/${BUCKET}`, {
    method: "POST",
    body: form,
  });

  const text = await res.text();
  assertEquals(res.status, 403, "Expected 403 for invalid signature");
  // MinIO returns SignatureDoesNotMatch; Herald returns AccessDenied
  const hasDenyOrBadSignature =
    /AccessDenied|Access Denied|SignatureDoesNotMatch|signature.*match/i
      .test(text);
  assertEquals(
    hasDenyOrBadSignature,
    true,
    `Response should indicate access denied or bad signature. Body: ${
      text.slice(0, 300)
    }`,
  );
}

async function postObjectSuccessAction200(
  client: S3Client,
  context: ProxyTestContext,
): Promise<void> {
  const key = "foo-200.txt";
  const body = "bar";
  const { policy, signature } = buildPolicyAndSignature(
    BUCKET,
    "foo",
    1024,
    "minioadmin",
    "minioadmin",
    [["eq", "$success_action_status", "200"]],
  );
  const form = new FormData();
  form.append("key", key);
  form.append("AWSAccessKeyId", "minioadmin");
  form.append("acl", "private");
  form.append("signature", signature);
  form.append("policy", policy);
  form.append("Content-Type", "text/plain");
  form.append("success_action_status", "200");
  form.append("file", new Blob([body]), "file.txt");

  const res = await fetch(`${context.baseUrl}/${BUCKET}`, {
    method: "POST",
    body: form,
  });
  assertEquals(res.status, 200, `Expected 200, got ${res.status}`);
  const resBody = await res.text();
  assertEquals(resBody, "", "Body should be empty for 200");
  const getRes = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
  );
  const gotBody = await getRes.Body?.transformToByteArray() ??
    new Uint8Array(0);
  assertEquals(new TextDecoder().decode(gotBody), body);
}

async function postObjectSuccessAction201(
  client: S3Client,
  context: ProxyTestContext,
): Promise<void> {
  const key = "foo-201.txt";
  const body = "baz";
  const { policy, signature } = buildPolicyAndSignature(
    BUCKET,
    "foo",
    1024,
    "minioadmin",
    "minioadmin",
    [["eq", "$success_action_status", "201"]],
  );
  const form = new FormData();
  form.append("key", key);
  form.append("AWSAccessKeyId", "minioadmin");
  form.append("acl", "private");
  form.append("signature", signature);
  form.append("policy", policy);
  form.append("Content-Type", "text/plain");
  form.append("success_action_status", "201");
  form.append("file", new Blob([body]), "file.txt");

  const res = await fetch(`${context.baseUrl}/${BUCKET}`, {
    method: "POST",
    body: form,
  });
  const xml = await res.text();
  assertEquals(
    res.status,
    201,
    `Expected 201, got ${res.status}. Body: ${xml.slice(0, 400)}`,
  );
  assertEquals(
    xml.includes("<Key>foo-201.txt</Key>") || xml.includes("foo-201.txt"),
    true,
    "201 response should include Key in XML",
  );
  const getRes = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
  );
  const gotBody = await getRes.Body?.transformToByteArray() ??
    new Uint8Array(0);
  assertEquals(new TextDecoder().decode(gotBody), body);
}

async function postObjectKeyFromFilename(
  client: S3Client,
  context: ProxyTestContext,
): Promise<void> {
  const keyPlaceholder = "${filename}";
  const body = "bar";
  const filename = "foo.txt";
  const { policy, signature } = buildPolicyAndSignature(
    BUCKET,
    "foo",
    1024,
    "minioadmin",
    "minioadmin",
  );
  const form = new FormData();
  form.append("key", keyPlaceholder);
  form.append("AWSAccessKeyId", "minioadmin");
  form.append("acl", "private");
  form.append("signature", signature);
  form.append("policy", policy);
  form.append("Content-Type", "text/plain");
  form.append("file", new Blob([body]), filename);

  const res = await fetch(`${context.baseUrl}/${BUCKET}`, {
    method: "POST",
    body: form,
  });
  assertEquals(res.status, 204, `Expected 204, got ${res.status}`);
  const getRes = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: filename }),
  );
  const gotBody = await getRes.Body?.transformToByteArray() ??
    new Uint8Array(0);
  assertEquals(new TextDecoder().decode(gotBody), body);
}

async function postObjectChecksumValid(
  client: S3Client,
  context: ProxyTestContext,
): Promise<void> {
  const key = "foo_cksum.txt";
  const body = "hello world";
  const bodyBytes = new TextEncoder().encode(body);
  const checksum = sha256Base64(bodyBytes);
  const { policy, signature } = buildPolicyAndSignature(
    BUCKET,
    "foo",
    1024,
    "minioadmin",
    "minioadmin",
    [["eq", "$x-amz-checksum-sha256", checksum]],
  );
  const form = new FormData();
  form.append("key", key);
  form.append("AWSAccessKeyId", "minioadmin");
  form.append("acl", "private");
  form.append("signature", signature);
  form.append("policy", policy);
  form.append("Content-Type", "text/plain");
  form.append("x-amz-checksum-sha256", checksum);
  form.append("file", new Blob([body]), "file.txt");

  const res = await fetch(`${context.baseUrl}/${BUCKET}`, {
    method: "POST",
    body: form,
  });
  assertEquals(
    res.status,
    204,
    `Expected 204 for valid checksum, got ${res.status}. Body: ${
      (await res.text()).slice(0, 400)
    }`,
  );
  const getRes = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
  );
  const gotBody = await getRes.Body?.transformToByteArray() ??
    new Uint8Array(0);
  assertEquals(new TextDecoder().decode(gotBody), body);
}

async function postObjectChecksumInvalid(
  _client: S3Client,
  context: ProxyTestContext,
): Promise<void> {
  const key = "foo_cksum_bad.txt";
  const body = "hello world";
  const { policy, signature } = buildPolicyAndSignature(
    BUCKET,
    "foo",
    1024,
    "minioadmin",
    "minioadmin",
    [["eq", "$x-amz-checksum-sha256", "invalidchecksumvalue"]],
  );
  const form = new FormData();
  form.append("key", key);
  form.append("AWSAccessKeyId", "minioadmin");
  form.append("acl", "private");
  form.append("signature", signature);
  form.append("policy", policy);
  form.append("Content-Type", "text/plain");
  form.append("x-amz-checksum-sha256", "invalidchecksumvalue");
  form.append("file", new Blob([body]), "file.txt");

  const res = await fetch(`${context.baseUrl}/${BUCKET}`, {
    method: "POST",
    body: form,
  });
  const text = await res.text();
  const invalidCksumOk = res.status === 400 || res.status === 204;
  assertEquals(
    invalidCksumOk,
    true,
    `Expected 400 (BadDigest) or 204 (backend may ignore checksum), got ${res.status}. Body: ${
      text.slice(0, 400)
    }`,
  );
  if (res.status === 400) {
    const hasBadDigest = /BadDigest|InvalidDigest|checksum|digest/i.test(text);
    assertEquals(
      hasBadDigest,
      true,
      `Response should indicate checksum/digest error. Body: ${
        text.slice(0, 300)
      }`,
    );
  }
}

async function postObjectMissingKey(
  _client: S3Client,
  context: ProxyTestContext,
): Promise<void> {
  const body = "bar";
  const { policy, signature } = buildPolicyAndSignature(
    BUCKET,
    "foo",
    1024,
    "minioadmin",
    "minioadmin",
  );
  const form = new FormData();
  form.append("key", "");
  form.append("AWSAccessKeyId", "minioadmin");
  form.append("acl", "private");
  form.append("signature", signature);
  form.append("policy", policy);
  form.append("Content-Type", "text/plain");
  form.append("file", new Blob([body]), "file.txt");

  const res = await fetch(`${context.baseUrl}/${BUCKET}`, {
    method: "POST",
    body: form,
  });
  const missingKeyBody = await res.text();
  const missingKeyOk = res.status === 400 || res.status === 403;
  assertEquals(
    missingKeyOk,
    true,
    `Expected 400 or 403 for missing key, got ${res.status}. Body: ${
      missingKeyBody.slice(0, 400)
    }`,
  );
}

// --- Checksum: case-insensitive form field (X-Amz-Checksum-Sha256) ---
async function postObjectChecksumCaseInsensitive(
  client: S3Client,
  context: ProxyTestContext,
): Promise<void> {
  const key = "foo_cksum_case.txt";
  const body = "hello";
  const bodyBytes = new TextEncoder().encode(body);
  const checksum = sha256Base64(bodyBytes);
  const { policy, signature } = buildPolicyAndSignature(
    BUCKET,
    "foo",
    1024,
    "minioadmin",
    "minioadmin",
    [["eq", "$x-amz-checksum-sha256", checksum]],
  );
  const form = new FormData();
  form.append("key", key);
  form.append("AWSAccessKeyId", "minioadmin");
  form.append("acl", "private");
  form.append("signature", signature);
  form.append("policy", policy);
  form.append("Content-Type", "text/plain");
  form.append("X-Amz-Checksum-Sha256", checksum);
  form.append("file", new Blob([body]), "file.txt");

  const res = await fetch(`${context.baseUrl}/${BUCKET}`, {
    method: "POST",
    body: form,
  });
  assertEquals(
    res.status,
    204,
    `Expected 204 for case-insensitive checksum field, got ${res.status}. Body: ${
      (await res.text()).slice(0, 400)
    }`,
  );
  const getRes = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
  );
  const gotBody = await getRes.Body?.transformToByteArray() ??
    new Uint8Array(0);
  assertEquals(new TextDecoder().decode(gotBody), body);
}

// --- Checksum: policy condition eq $x-amz-checksum-sha256 ---
async function postObjectChecksumPolicyEq(
  client: S3Client,
  context: ProxyTestContext,
): Promise<void> {
  const key = "foo_cksum_policy.txt";
  const body = "policy checksum";
  const bodyBytes = new TextEncoder().encode(body);
  const checksum = sha256Base64(bodyBytes);
  const expires = new Date(Date.now() + 6000 * 1000);
  const policyDoc = {
    expiration: expires.toISOString().replace(/\.\d{3}Z$/, "Z"),
    conditions: [
      { bucket: BUCKET },
      ["starts-with", "$key", "foo"],
      { acl: "private" },
      ["starts-with", "$Content-Type", "text/plain"],
      ["content-length-range", 0, 1024],
      ["eq", "$x-amz-checksum-sha256", checksum],
    ],
  };
  const { policy, signature } = buildPolicyFromDoc(policyDoc, "minioadmin");
  const form = new FormData();
  form.append("key", key);
  form.append("AWSAccessKeyId", "minioadmin");
  form.append("acl", "private");
  form.append("signature", signature);
  form.append("policy", policy);
  form.append("Content-Type", "text/plain");
  form.append("x-amz-checksum-sha256", checksum);
  form.append("file", new Blob([body]), "file.txt");

  const res = await fetch(`${context.baseUrl}/${BUCKET}`, {
    method: "POST",
    body: form,
  });
  assertEquals(
    res.status,
    204,
    `Expected 204 when policy eq checksum matches, got ${res.status}. Body: ${
      (await res.text()).slice(0, 400)
    }`,
  );
  const getRes = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
  );
  const gotBody = await getRes.Body?.transformToByteArray() ??
    new Uint8Array(0);
  assertEquals(new TextDecoder().decode(gotBody), body);
}

// --- Policy present but signature omitted (s3-tests expect 400) ---
async function postObjectMissingSignature(
  _client: S3Client,
  context: ProxyTestContext,
): Promise<void> {
  const key = "foo.txt";
  const { policy } = buildPolicyAndSignature(
    BUCKET,
    "foo",
    1024,
    "minioadmin",
    "minioadmin",
  );
  const form = new FormData();
  form.append("key", key);
  form.append("AWSAccessKeyId", "minioadmin");
  form.append("acl", "private");
  form.append("policy", policy);
  form.append("Content-Type", "text/plain");
  form.append("file", new Blob(["bar"]), "file.txt");

  const res = await fetch(`${context.baseUrl}/${BUCKET}`, {
    method: "POST",
    body: form,
  });
  const text = await res.text();
  const ok = res.status === 400 || res.status === 403;
  assertEquals(
    ok,
    true,
    `Expected 400 or 403 for missing signature, got ${res.status}. Body: ${
      text.slice(0, 400)
    }`,
  );
}

// --- Expired policy (expiration in the past) ---
async function postObjectExpiredPolicy(
  _client: S3Client,
  context: ProxyTestContext,
): Promise<void> {
  const key = "foo.txt";
  const expired = new Date(Date.now() - 60000);
  const policyDoc = {
    expiration: expired.toISOString().replace(/\.\d{3}Z$/, "Z"),
    conditions: [
      { bucket: BUCKET },
      ["starts-with", "$key", "foo"],
      { acl: "private" },
      ["starts-with", "$Content-Type", "text/plain"],
      ["content-length-range", 0, 1024],
    ],
  };
  const { policy, signature } = buildPolicyFromDoc(policyDoc, "minioadmin");
  const form = new FormData();
  form.append("key", key);
  form.append("AWSAccessKeyId", "minioadmin");
  form.append("acl", "private");
  form.append("signature", signature);
  form.append("policy", policy);
  form.append("Content-Type", "text/plain");
  form.append("file", new Blob(["bar"]), "file.txt");

  const res = await fetch(`${context.baseUrl}/${BUCKET}`, {
    method: "POST",
    body: form,
  });
  const text = await res.text();
  assertEquals(
    res.status,
    403,
    `Expected 403 for expired policy, got ${res.status}. Body: ${
      text.slice(0, 400)
    }`,
  );
}

// --- Policy bucket does not match URL bucket ---
async function postObjectWrongBucketInPolicy(
  _client: S3Client,
  context: ProxyTestContext,
): Promise<void> {
  const key = "foo.txt";
  const policyDoc = {
    expiration: new Date(Date.now() + 6000 * 1000)
      .toISOString().replace(/\.\d{3}Z$/, "Z"),
    conditions: [
      { bucket: "other-bucket-name" },
      ["starts-with", "$key", "foo"],
      { acl: "private" },
      ["starts-with", "$Content-Type", "text/plain"],
      ["content-length-range", 0, 1024],
    ],
  };
  const { policy, signature } = buildPolicyFromDoc(policyDoc, "minioadmin");
  const form = new FormData();
  form.append("key", key);
  form.append("AWSAccessKeyId", "minioadmin");
  form.append("acl", "private");
  form.append("signature", signature);
  form.append("policy", policy);
  form.append("Content-Type", "text/plain");
  form.append("file", new Blob(["bar"]), "file.txt");

  const res = await fetch(`${context.baseUrl}/${BUCKET}`, {
    method: "POST",
    body: form,
  });
  const text = await res.text();
  assertEquals(
    res.status,
    403,
    `Expected 403 for wrong bucket in policy, got ${res.status}. Body: ${
      text.slice(0, 400)
    }`,
  );
}

// --- content-length-range exceeded (body larger than max) ---
async function postObjectContentLengthExceeded(
  _client: S3Client,
  context: ProxyTestContext,
): Promise<void> {
  const key = "foo.txt";
  const policyDoc = {
    expiration: new Date(Date.now() + 6000 * 1000)
      .toISOString().replace(/\.\d{3}Z$/, "Z"),
    conditions: [
      { bucket: BUCKET },
      ["starts-with", "$key", "foo"],
      { acl: "private" },
      ["starts-with", "$Content-Type", "text/plain"],
      ["content-length-range", 0, 10],
    ],
  };
  const { policy, signature } = buildPolicyFromDoc(policyDoc, "minioadmin");
  const form = new FormData();
  form.append("key", key);
  form.append("AWSAccessKeyId", "minioadmin");
  form.append("acl", "private");
  form.append("signature", signature);
  form.append("policy", policy);
  form.append("Content-Type", "text/plain");
  form.append("file", new Blob(["x".repeat(20)]), "file.txt");

  const res = await fetch(`${context.baseUrl}/${BUCKET}`, {
    method: "POST",
    body: form,
  });
  const text = await res.text();
  const ok = res.status === 400 || res.status === 403;
  assertEquals(
    ok,
    true,
    `Expected 400 or 403 for content-length exceeded, got ${res.status}. Body: ${
      text.slice(0, 400)
    }`,
  );
}

// --- content-length-range below minimum ---
async function postObjectContentLengthBelowMin(
  _client: S3Client,
  context: ProxyTestContext,
): Promise<void> {
  const key = "foo.txt";
  const policyDoc = {
    expiration: new Date(Date.now() + 6000 * 1000)
      .toISOString().replace(/\.\d{3}Z$/, "Z"),
    conditions: [
      { bucket: BUCKET },
      ["starts-with", "$key", "foo"],
      { acl: "private" },
      ["starts-with", "$Content-Type", "text/plain"],
      ["content-length-range", 10, 100],
    ],
  };
  const { policy, signature } = buildPolicyFromDoc(policyDoc, "minioadmin");
  const form = new FormData();
  form.append("key", key);
  form.append("AWSAccessKeyId", "minioadmin");
  form.append("acl", "private");
  form.append("signature", signature);
  form.append("policy", policy);
  form.append("Content-Type", "text/plain");
  form.append("file", new Blob(["xxxxx"]), "file.txt");

  const res = await fetch(`${context.baseUrl}/${BUCKET}`, {
    method: "POST",
    body: form,
  });
  const text = await res.text();
  const ok = res.status === 400 || res.status === 403;
  assertEquals(
    ok,
    true,
    `Expected 400 or 403 for content-length below min, got ${res.status}. Body: ${
      text.slice(0, 400)
    }`,
  );
}

// --- Strict policy: extra form field not in policy → 403 ---
async function postObjectExtraFormFieldNotInPolicy(
  _client: S3Client,
  context: ProxyTestContext,
): Promise<void> {
  const key = "foo.txt";
  const { policy, signature } = buildPolicyAndSignature(
    BUCKET,
    "foo",
    1024,
    "minioadmin",
    "minioadmin",
  );
  const form = new FormData();
  form.append("key", key);
  form.append("AWSAccessKeyId", "minioadmin");
  form.append("acl", "private");
  form.append("signature", signature);
  form.append("policy", policy);
  form.append("Content-Type", "text/plain");
  form.append("x-amz-meta-foo", "bar");
  form.append("file", new Blob(["bar"]), "file.txt");

  const res = await fetch(`${context.baseUrl}/${BUCKET}`, {
    method: "POST",
    body: form,
  });
  const text = await res.text();
  assertEquals(
    res.status,
    403,
    `Expected 403 for extra form field not in policy, got ${res.status}. Body: ${
      text.slice(0, 400)
    }`,
  );
  const hasPolicyMessage = /policy|not specified|form field/i.test(text);
  assertEquals(
    hasPolicyMessage,
    true,
    `Response should mention policy/form field. Body: ${text.slice(0, 300)}`,
  );
}

async function postObjectBodyIntegrityChunkLikePayload(
  client: S3Client,
  context: ProxyTestContext,
): Promise<void> {
  const key = "chunk-like-body.txt";
  const body =
    "46f;chunk-signature=abc\r\nhello\r\n0;chunk-signature=def\r\n\r\n";
  const { policy, signature } = buildPolicyAndSignature(
    BUCKET,
    "chunk-like",
    4096,
    "minioadmin",
    "minioadmin",
  );

  const form = new FormData();
  form.append("key", key);
  form.append("AWSAccessKeyId", "minioadmin");
  form.append("acl", "private");
  form.append("signature", signature);
  form.append("policy", policy);
  form.append("Content-Type", "text/plain");
  form.append("file", new Blob([body]), "file.txt");

  const res = await fetch(`${context.baseUrl}/${BUCKET}`, {
    method: "POST",
    body: form,
  });
  const resText = await res.text();
  assertEquals(
    res.status,
    204,
    `Expected 204 for PostObject body integrity test, got ${res.status}. Body: ${
      resText.slice(0, 400)
    }`,
  );

  const getRes = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
  );
  const gotBody = await getRes.Body?.transformToByteArray() ??
    new Uint8Array(0);
  const storedText = new TextDecoder().decode(gotBody);
  assertEquals(storedText.includes("46f;chunk-signature=abc"), true);
  assertEquals(storedText.includes("hello"), true);
  assertEquals(storedText.includes("0;chunk-signature=def"), true);

  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

const cases: ProxyTestCase[] = [
  {
    name: "postobject/authenticated",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: async (client: S3Client) => {
      try {
        await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore if already exists */ }
    },
    afterAll: async (client: S3Client) => {
      try {
        await client.send(new DeleteBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    fn: (client, context) => {
      if (!context) throw new Error("PostObject tests require baseUrl");
      return postObjectAuthenticated(client, context);
    },
  },
  {
    name: "postobject/invalid_signature",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: async (client: S3Client) => {
      try {
        await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore if already exists */ }
    },
    afterAll: async (client: S3Client) => {
      try {
        await client.send(new DeleteBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    fn: (client, context) => {
      if (!context) throw new Error("PostObject tests require baseUrl");
      return postObjectInvalidSignature(client, context);
    },
  },
  {
    name: "postobject/success_action_200",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: async (c) => {
      try {
        await c.send(new CreateBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    afterAll: async (c) => {
      try {
        await c.send(new DeleteBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    fn: (client, context) => {
      if (!context) throw new Error("PostObject tests require baseUrl");
      return postObjectSuccessAction200(client, context);
    },
  },
  {
    name: "postobject/success_action_201",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: async (c) => {
      try {
        await c.send(new CreateBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    afterAll: async (c) => {
      try {
        await c.send(new DeleteBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    fn: (client, context) => {
      if (!context) throw new Error("PostObject tests require baseUrl");
      return postObjectSuccessAction201(client, context);
    },
  },
  {
    name: "postobject/key_from_filename",
    config: testConfig,
    skipSnapshot: true,
    ignoreBaseline: true,
    beforeAll: async (c) => {
      try {
        await c.send(new CreateBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    afterAll: async (c) => {
      try {
        await c.send(new DeleteBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    fn: (client, context) => {
      if (!context) throw new Error("PostObject tests require baseUrl");
      return postObjectKeyFromFilename(client, context);
    },
  },
  {
    name: "postobject/checksum_valid",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: async (c) => {
      try {
        await c.send(new CreateBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    afterAll: async (c) => {
      try {
        await c.send(new DeleteBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    fn: (client, context) => {
      if (!context) throw new Error("PostObject tests require baseUrl");
      return postObjectChecksumValid(client, context);
    },
  },
  {
    name: "postobject/checksum_invalid",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: async (c) => {
      try {
        await c.send(new CreateBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    afterAll: async (c) => {
      try {
        await c.send(new DeleteBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    fn: (client, context) => {
      if (!context) throw new Error("PostObject tests require baseUrl");
      return postObjectChecksumInvalid(client, context);
    },
  },
  {
    name: "postobject/missing_key",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: async (c) => {
      try {
        await c.send(new CreateBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    afterAll: async (c) => {
      try {
        await c.send(new DeleteBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    fn: (client, context) => {
      if (!context) throw new Error("PostObject tests require baseUrl");
      return postObjectMissingKey(client, context);
    },
  },
  {
    name: "postobject/checksum_case_insensitive",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: async (c) => {
      try {
        await c.send(new CreateBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    afterAll: async (c) => {
      try {
        await c.send(new DeleteBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    fn: (client, context) => {
      if (!context) throw new Error("PostObject tests require baseUrl");
      return postObjectChecksumCaseInsensitive(client, context);
    },
  },
  {
    name: "postobject/checksum_policy_eq",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: async (c) => {
      try {
        await c.send(new CreateBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    afterAll: async (c) => {
      try {
        await c.send(new DeleteBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    fn: (client, context) => {
      if (!context) throw new Error("PostObject tests require baseUrl");
      return postObjectChecksumPolicyEq(client, context);
    },
  },
  {
    name: "postobject/missing_signature",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: async (c) => {
      try {
        await c.send(new CreateBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    afterAll: async (c) => {
      try {
        await c.send(new DeleteBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    fn: (client, context) => {
      if (!context) throw new Error("PostObject tests require baseUrl");
      return postObjectMissingSignature(client, context);
    },
  },
  {
    name: "postobject/expired_policy",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: async (c) => {
      try {
        await c.send(new CreateBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    afterAll: async (c) => {
      try {
        await c.send(new DeleteBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    fn: (client, context) => {
      if (!context) throw new Error("PostObject tests require baseUrl");
      return postObjectExpiredPolicy(client, context);
    },
  },
  {
    name: "postobject/wrong_bucket_in_policy",
    config: testConfig,
    skipSnapshot: true,
    ignoreBaseline: true,
    beforeAll: async (c) => {
      try {
        await c.send(new CreateBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    afterAll: async (c) => {
      try {
        await c.send(new DeleteBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    fn: (client, context) => {
      if (!context) throw new Error("PostObject tests require baseUrl");
      return postObjectWrongBucketInPolicy(client, context);
    },
  },
  {
    name: "postobject/content_length_exceeded",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: async (c) => {
      try {
        await c.send(new CreateBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    afterAll: async (c) => {
      try {
        await c.send(new DeleteBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    fn: (client, context) => {
      if (!context) throw new Error("PostObject tests require baseUrl");
      return postObjectContentLengthExceeded(client, context);
    },
  },
  {
    name: "postobject/content_length_below_min",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: async (c) => {
      try {
        await c.send(new CreateBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    afterAll: async (c) => {
      try {
        await c.send(new DeleteBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    fn: (client, context) => {
      if (!context) throw new Error("PostObject tests require baseUrl");
      return postObjectContentLengthBelowMin(client, context);
    },
  },
  {
    name: "postobject/extra_form_field_not_in_policy",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: async (c) => {
      try {
        await c.send(new CreateBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    afterAll: async (c) => {
      try {
        await c.send(new DeleteBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    fn: (client, context) => {
      if (!context) throw new Error("PostObject tests require baseUrl");
      return postObjectExtraFormFieldNotInPolicy(client, context);
    },
  },
  {
    name: "postobject/body_integrity_chunk_like_payload",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: async (c) => {
      try {
        await c.send(new CreateBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    afterAll: async (c) => {
      try {
        await c.send(new DeleteBucketCommand({ Bucket: BUCKET }));
      } catch { /* ignore */ }
    },
    fn: (client, context) => {
      if (!context) throw new Error("PostObject tests require baseUrl");
      return postObjectBodyIntegrityChunkLikePayload(client, context);
    },
  },
];

harness(cases);
