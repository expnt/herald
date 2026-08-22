import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { assertEquals } from "@std/assert";
import { harness, type ProxyTestCase } from "./utils.ts";
import type { GlobalConfig } from "../src/Domain/Config.ts";

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

const BUCKET = "test-listing-bucket";

const putKeys = async (client: S3Client, keys: string[]) => {
  for (const key of keys) {
    // deno-lint-ignore no-await-in-loop
    await client.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "x" }),
    );
  }
};

const deleteKeys = async (client: S3Client, keys: string[]) => {
  for (const key of keys) {
    // deno-lint-ignore no-await-in-loop
    await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  }
};

const getKeys = (r: { Contents?: { Key?: string }[] }) =>
  (r.Contents ?? [])
    .map((c) => c.Key)
    .filter((k): k is string => k !== undefined);

const getPrefixes = (r: { CommonPrefixes?: { Prefix?: string }[] }) =>
  (r.CommonPrefixes ?? [])
    .map((c) => c.Prefix)
    .filter((p): p is string => p !== undefined);

const cases: ProxyTestCase[] = [
  {
    name: "listing/delimiter-basic-v1",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: (c) =>
      putKeys(c, ["foo/bar", "foo/bar/xyzzy", "quux/thud", "asdf"]),
    afterAll: (c) =>
      deleteKeys(c, ["foo/bar", "foo/bar/xyzzy", "quux/thud", "asdf"]),
    fn: async (client) => {
      const r = await client.send(
        new ListObjectsCommand({ Bucket: BUCKET, Delimiter: "/" }),
      );
      assertEquals(r.Delimiter, "/");
      assertEquals(getKeys(r), ["asdf"]);
      assertEquals(getPrefixes(r), ["foo/", "quux/"]);
    },
  },
  {
    name: "listing/delimiter-basic-v2",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: (c) =>
      putKeys(c, ["foo/bar", "foo/bar/xyzzy", "quux/thud", "asdf"]),
    afterAll: (c) =>
      deleteKeys(c, ["foo/bar", "foo/bar/xyzzy", "quux/thud", "asdf"]),
    fn: async (client) => {
      const r = await client.send(
        new ListObjectsV2Command({ Bucket: BUCKET, Delimiter: "/" }),
      );
      assertEquals(r.Delimiter, "/");
      assertEquals(getKeys(r), ["asdf"]);
      assertEquals(getPrefixes(r), ["foo/", "quux/"]);
      assertEquals(r.KeyCount, 3);
    },
  },
  {
    name: "listing/delimiter-prefix",
    config: testConfig,
    skipSnapshot: true,
    // MinIO leaks an internal "[minio_cache:v2,return:]" suffix in its
    // NextMarker; Herald strips it, which is what this test verifies.
    ignoreBaseline: true,
    beforeAll: (c) =>
      putKeys(c, [
        "asdf",
        "boo/bar",
        "boo/baz/xyzzy",
        "cquux/thud",
        "cquux/bla",
      ]),
    afterAll: (c) =>
      deleteKeys(c, [
        "asdf",
        "boo/bar",
        "boo/baz/xyzzy",
        "cquux/thud",
        "cquux/bla",
      ]),
    fn: async (client) => {
      // v1: walk pages with MaxKeys=1, following NextMarker.
      let r = await client.send(
        new ListObjectsCommand({
          Bucket: BUCKET,
          Delimiter: "/",
          MaxKeys: 1,
        }),
      );
      assertEquals(r.IsTruncated, true);
      assertEquals(getKeys(r), ["asdf"]);
      assertEquals(getPrefixes(r), []);
      assertEquals(r.NextMarker, "asdf");

      r = await client.send(
        new ListObjectsCommand({
          Bucket: BUCKET,
          Delimiter: "/",
          MaxKeys: 1,
          Marker: r.NextMarker,
        }),
      );
      assertEquals(r.IsTruncated, true);
      assertEquals(getKeys(r), []);
      assertEquals(getPrefixes(r), ["boo/"]);
      assertEquals(r.NextMarker, "boo/");

      r = await client.send(
        new ListObjectsCommand({
          Bucket: BUCKET,
          Delimiter: "/",
          MaxKeys: 1,
          Marker: r.NextMarker,
        }),
      );
      assertEquals(r.IsTruncated, false);
      assertEquals(getKeys(r), []);
      assertEquals(getPrefixes(r), ["cquux/"]);
      assertEquals(r.NextMarker, undefined);

      // v2: walk pages with MaxKeys=1, following NextContinuationToken.
      let v2 = await client.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          Delimiter: "/",
          MaxKeys: 1,
        }),
      );
      assertEquals(v2.IsTruncated, true);
      assertEquals(getKeys(v2), ["asdf"]);
      assertEquals(getPrefixes(v2), []);
      const token1 = v2.NextContinuationToken;
      assertEquals(typeof token1, "string");

      v2 = await client.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          Delimiter: "/",
          MaxKeys: 1,
          ContinuationToken: token1,
        }),
      );
      assertEquals(v2.IsTruncated, true);
      assertEquals(getKeys(v2), []);
      assertEquals(getPrefixes(v2), ["boo/"]);
      const token2 = v2.NextContinuationToken;
      assertEquals(typeof token2, "string");

      v2 = await client.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          Delimiter: "/",
          MaxKeys: 1,
          ContinuationToken: token2,
        }),
      );
      assertEquals(v2.IsTruncated, false);
      assertEquals(getKeys(v2), []);
      assertEquals(getPrefixes(v2), ["cquux/"]);
      assertEquals(v2.NextContinuationToken, undefined);
    },
  },
  {
    name: "listing/v2-pagination-no-dupes-gaps",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: (c) =>
      putKeys(c, ["a0", "a1", "a2", "a3", "b0", "b1", "b2", "c0", "c1"]),
    afterAll: (c) =>
      deleteKeys(c, ["a0", "a1", "a2", "a3", "b0", "b1", "b2", "c0", "c1"]),
    fn: async (client) => {
      const seen: string[] = [];
      let token: string | undefined;
      for (let i = 0; i < 20; i++) {
        // deno-lint-ignore no-await-in-loop
        const r = await client.send(
          new ListObjectsV2Command({
            Bucket: BUCKET,
            MaxKeys: 2,
            ...(token ? { ContinuationToken: token } : {}),
          }),
        );
        seen.push(...getKeys(r));
        if (!r.IsTruncated) break;
        token = r.NextContinuationToken;
      }
      assertEquals(seen, [
        "a0",
        "a1",
        "a2",
        "a3",
        "b0",
        "b1",
        "b2",
        "c0",
        "c1",
      ]);
    },
  },
  {
    name: "listing/startafter",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: (c) => putKeys(c, ["bar", "baz", "foo", "quxx"]),
    afterAll: (c) => deleteKeys(c, ["bar", "baz", "foo", "quxx"]),
    fn: async (client) => {
      const r = await client.send(
        new ListObjectsV2Command({ Bucket: BUCKET, StartAfter: "bar" }),
      );
      assertEquals(r.StartAfter, "bar");
      assertEquals(getKeys(r), ["baz", "foo", "quxx"]);
    },
  },
  {
    name: "listing/startafter-not-in-list",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: (c) => putKeys(c, ["bar", "baz", "foo", "quxx"]),
    afterAll: (c) => deleteKeys(c, ["bar", "baz", "foo", "quxx"]),
    fn: async (client) => {
      const r = await client.send(
        new ListObjectsV2Command({ Bucket: BUCKET, StartAfter: "blah" }),
      );
      assertEquals(r.StartAfter, "blah");
      assertEquals(getKeys(r), ["foo", "quxx"]);
    },
  },
  {
    name: "listing/startafter-after-list",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: (c) => putKeys(c, ["bar", "baz", "foo", "quxx"]),
    afterAll: (c) => deleteKeys(c, ["bar", "baz", "foo", "quxx"]),
    fn: async (client) => {
      const r = await client.send(
        new ListObjectsV2Command({ Bucket: BUCKET, StartAfter: "quxx" }),
      );
      assertEquals(r.StartAfter, "quxx");
      assertEquals(getKeys(r), []);
      assertEquals(r.KeyCount, 0);
    },
  },
  {
    name: "listing/startafter-plus-continuation-token",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: (c) => putKeys(c, ["bar", "baz", "foo", "quxx"]),
    afterAll: (c) => deleteKeys(c, ["bar", "baz", "foo", "quxx"]),
    fn: async (client) => {
      const r1 = await client.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          StartAfter: "bar",
          MaxKeys: 1,
        }),
      );
      const token = r1.NextContinuationToken;
      assertEquals(typeof token, "string");

      const r2 = await client.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          StartAfter: "bar",
          ContinuationToken: token,
        }),
      );
      assertEquals(r2.ContinuationToken, token);
      assertEquals(r2.StartAfter, "bar");
      assertEquals(r2.IsTruncated, false);
      assertEquals(getKeys(r2), ["foo", "quxx"]);
    },
  },
  {
    name: "listing/empty-continuation-token",
    config: testConfig,
    skipSnapshot: true,
    // MinIO rejects an empty ContinuationToken; Herald treats it as a no-op
    // and echoes it, which is what this test verifies.
    ignoreBaseline: true,
    beforeAll: (c) => putKeys(c, ["bar", "baz", "foo", "quxx"]),
    afterAll: (c) => deleteKeys(c, ["bar", "baz", "foo", "quxx"]),
    fn: async (client) => {
      const r = await client.send(
        new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: "" }),
      );
      assertEquals(r.ContinuationToken, "");
      assertEquals(r.IsTruncated, false);
      assertEquals(getKeys(r), ["bar", "baz", "foo", "quxx"]);
    },
  },
  {
    name: "listing/prefix-plus-delimiter",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: (c) =>
      putKeys(c, ["boo/bar", "boo/baz/xyzzy", "cquux/thud", "asdf"]),
    afterAll: (c) =>
      deleteKeys(c, ["boo/bar", "boo/baz/xyzzy", "cquux/thud", "asdf"]),
    fn: async (client) => {
      const r = await client.send(
        new ListObjectsCommand({
          Bucket: BUCKET,
          Prefix: "boo/",
          Delimiter: "/",
        }),
      );
      assertEquals(r.Prefix, "boo/");
      assertEquals(r.Delimiter, "/");
      assertEquals(getKeys(r), ["boo/bar"]);
      assertEquals(getPrefixes(r), ["boo/baz/"]);
    },
  },
];

const resetBucket = async (client: S3Client) => {
  // Empty the bucket if it exists (a previous failed run may have left
  // objects behind), then delete it, then recreate it fresh.
  try {
    for (let i = 0; i < 10; i++) {
      // deno-lint-ignore no-await-in-loop
      const listed = await client.send(
        new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 1000 }),
      );
      const keys = (listed.Contents ?? []).map((c) => c.Key);
      if (keys.length === 0) break;
      // deno-lint-ignore no-await-in-loop
      await client.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: { Objects: keys.map((k) => ({ Key: k })) },
        }),
      );
    }
  } catch {
    // bucket does not exist
  }
  try {
    await client.send(new DeleteBucketCommand({ Bucket: BUCKET }));
  } catch {
    // ignore
  }
  await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
};

const withBucket = (tc: ProxyTestCase): ProxyTestCase => ({
  ...tc,
  beforeAll: async (client: S3Client) => {
    await resetBucket(client);
    await tc.beforeAll?.(client);
  },
  afterAll: async (client: S3Client) => {
    await tc.afterAll?.(client);
    try {
      await client.send(new DeleteBucketCommand({ Bucket: BUCKET }));
    } catch {
      // ignore
    }
  },
});

harness(cases.map(withBucket));
