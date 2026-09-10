/**
 * Anonymous / public-access integration tests. Anonymous requests carry no
 * Authorization header; Herald authorizes them against the bucket/object ACL
 * (AllUsers group grants) instead of denying by default. Private buckets and
 * objects must yield 403 AccessDenied (never a 500), and public-read /
 * public-read-write ACLs must permit the corresponding anonymous operations.
 *
 * The Baseline runner is skipped: it hits the backend directly, whose
 * anonymous behavior is not what these tests exercise (Herald's ACL gate is).
 *
 * Run: deno test tests/integration/anonymous.test.ts --allow-env --allow-net --allow-sys
 */
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  PutBucketAclCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { assert, assertEquals } from "@std/assert";
import {
  harness,
  type ProxyTestCase,
  type ProxyTestContext,
} from "../utils.ts";
import type { GlobalConfig } from "../../src/Domain/Config.ts";

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

const anonGet = (baseUrl: string, path: string): Promise<Response> =>
  fetch(`${baseUrl}${path}`);

const anonPut = (
  baseUrl: string,
  path: string,
  body: string,
): Promise<Response> => fetch(`${baseUrl}${path}`, { method: "PUT", body });

const anonDelete = (baseUrl: string, path: string): Promise<Response> =>
  fetch(`${baseUrl}${path}`, { method: "DELETE" });

const requireBaseUrl = (context: ProxyTestContext | undefined): string => {
  if (!context?.baseUrl) {
    throw new Error("Missing baseUrl in test context");
  }
  return context.baseUrl;
};

interface AnonTestSpec {
  name: string;
  bucket: string;
  key?: string;
  beforeAll: (client: S3Client) => Promise<void>;
  fn: (client: S3Client, context: ProxyTestContext) => Promise<void>;
}

const specs: AnonTestSpec[] = [
  {
    name: "anon/list-public-read",
    bucket: "anon-list-public",
    beforeAll: async (c) => {
      await c.send(new CreateBucketCommand({ Bucket: "anon-list-public" }));
      await c.send(
        new PutBucketAclCommand({
          Bucket: "anon-list-public",
          ACL: "public-read",
        }),
      );
    },
    fn: async (_c, context) => {
      const res = await anonGet(requireBaseUrl(context), "/anon-list-public");
      assertEquals(
        res.status,
        200,
        `anonymous list on public-read bucket should succeed, got ${res.status}`,
      );
    },
  },
  {
    name: "anon/list-private",
    bucket: "anon-list-private",
    beforeAll: async (c) => {
      await c.send(new CreateBucketCommand({ Bucket: "anon-list-private" }));
    },
    fn: async (_c, context) => {
      const res = await anonGet(requireBaseUrl(context), "/anon-list-private");
      assertEquals(
        res.status,
        403,
        `anonymous list on private bucket should be denied, got ${res.status}`,
      );
      const body = await res.text();
      assert(
        body.includes("AccessDenied"),
        "expected AccessDenied in error body",
      );
    },
  },
  {
    name: "anon/get-public-object",
    bucket: "anon-get-public",
    key: "obj",
    beforeAll: async (c) => {
      await c.send(new CreateBucketCommand({ Bucket: "anon-get-public" }));
      await c.send(
        new PutObjectCommand({
          Bucket: "anon-get-public",
          Key: "obj",
          Body: "hello",
          ACL: "public-read",
        }),
      );
    },
    fn: async (_c, context) => {
      const res = await anonGet(
        requireBaseUrl(context),
        "/anon-get-public/obj",
      );
      assertEquals(
        res.status,
        200,
        `anonymous GET on public-read object should succeed, got ${res.status}`,
      );
      const body = await res.text();
      assertEquals(body, "hello");
    },
  },
  {
    name: "anon/get-private-object",
    bucket: "anon-get-private",
    key: "obj",
    beforeAll: async (c) => {
      await c.send(new CreateBucketCommand({ Bucket: "anon-get-private" }));
      await c.send(
        new PutObjectCommand({
          Bucket: "anon-get-private",
          Key: "obj",
          Body: "hello",
        }),
      );
    },
    fn: async (_c, context) => {
      const res = await anonGet(
        requireBaseUrl(context),
        "/anon-get-private/obj",
      );
      assertEquals(
        res.status,
        403,
        `anonymous GET on private object should be denied, got ${res.status}`,
      );
    },
  },
  {
    name: "anon/put-private",
    bucket: "anon-put-private",
    key: "obj",
    beforeAll: async (c) => {
      await c.send(new CreateBucketCommand({ Bucket: "anon-put-private" }));
    },
    fn: async (_c, context) => {
      const res = await anonPut(
        requireBaseUrl(context),
        "/anon-put-private/obj",
        "data",
      );
      assertEquals(
        res.status,
        403,
        `anonymous PUT on private bucket should be denied, got ${res.status}`,
      );
    },
  },
  {
    name: "anon/put-public-read-write",
    bucket: "anon-put-publicrw",
    key: "obj",
    beforeAll: async (c) => {
      await c.send(
        new CreateBucketCommand({
          Bucket: "anon-put-publicrw",
          ACL: "public-read-write",
        }),
      );
    },
    fn: async (_c, context) => {
      const res = await anonPut(
        requireBaseUrl(context),
        "/anon-put-publicrw/obj",
        "data",
      );
      assertEquals(
        res.status,
        200,
        `anonymous PUT on public-read-write bucket should succeed, got ${res.status}`,
      );
    },
  },
  {
    name: "anon/delete-private",
    bucket: "anon-del-private",
    key: "obj",
    beforeAll: async (c) => {
      await c.send(new CreateBucketCommand({ Bucket: "anon-del-private" }));
      await c.send(
        new PutObjectCommand({
          Bucket: "anon-del-private",
          Key: "obj",
          Body: "hello",
        }),
      );
    },
    fn: async (_c, context) => {
      const res = await anonDelete(
        requireBaseUrl(context),
        "/anon-del-private/obj",
      );
      assertEquals(
        res.status,
        403,
        `anonymous DELETE on private bucket should be 403 (not 500), got ${res.status}`,
      );
    },
  },
];

const cases: ProxyTestCase[] = specs.map((spec) => ({
  name: spec.name,
  config: testConfig,
  beforeAll: (client: S3Client) => spec.beforeAll(client),
  afterAll: async (client: S3Client) => {
    if (spec.key !== undefined) {
      try {
        await client.send(
          new DeleteObjectCommand({ Bucket: spec.bucket, Key: spec.key }),
        );
      } catch {
        // ignore cleanup failures
      }
    }
    try {
      await client.send(new DeleteBucketCommand({ Bucket: spec.bucket }));
    } catch {
      // ignore cleanup failures
    }
  },
  fn: (client: S3Client, context?: ProxyTestContext) =>
    spec.fn(client, context as ProxyTestContext),
  skipSnapshot: true,
  ignoreBaseline: true,
}));

harness(cases);
