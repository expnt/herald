import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { harness, type ProxyTestCase } from "./utils.ts";
import type { GlobalConfig } from "../src/Domain/Config.ts";

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
  {
    name: "listing/fetch-owner-v2",
    config: testConfig,
    skipSnapshot: true,
    beforeAll: (c) => putKeys(c, ["asdf"]),
    afterAll: (c) => deleteKeys(c, ["asdf"]),
    fn: async (client) => {
      // Regression: s3-tests test_bucket_listv2_fetchowner_notempty requires
      // an <Owner> element in each Contents entry when FetchOwner=true.
      const withOwner = await client.send(
        new ListObjectsV2Command({ Bucket: BUCKET, FetchOwner: true }),
      );
      const owner = withOwner.Contents?.[0]?.Owner;
      assertEquals(
        owner !== undefined,
        true,
        "Owner missing with FetchOwner=true",
      );
      assertEquals(typeof owner?.ID, "string");
      assertEquals(typeof owner?.DisplayName, "string");

      // Default must stay owner-less (test_bucket_listv2_fetchowner_defaultempty).
      const withoutOwner = await client.send(
        new ListObjectsV2Command({ Bucket: BUCKET }),
      );
      assertEquals(withoutOwner.Contents?.[0]?.Owner, undefined);
    },
  },
  {
    name: "listing/delimiter-unreadable",
    config: testConfig,
    skipSnapshot: true,
    // Regression: s3-tests *_delimiter_unreadable uses a control character
    // (newline) as delimiter; S3 always echoes the request value back.
    ignoreBaseline: true,
    beforeAll: (c) => putKeys(c, ["foo/bar", "foo/bar/xyzzy", "asdf"]),
    afterAll: (c) => deleteKeys(c, ["foo/bar", "foo/bar/xyzzy", "asdf"]),
    fn: async (client, context) => {
      // The AWS JS SDK's XML parser normalizes whitespace-only text nodes,
      // so a control-char delimiter can only be asserted on the raw XML body.
      if (!context) throw new Error("context required");
      await client.send(
        new ListObjectsCommand({ Bucket: BUCKET, Delimiter: "\n" }),
      );
      assertStringIncludes(
        context.lastRawBody() ?? "",
        "<Delimiter>&#x0A;</Delimiter>",
      );
      await client.send(
        new ListObjectsV2Command({ Bucket: BUCKET, Delimiter: "\n" }),
      );
      assertStringIncludes(
        context.lastRawBody() ?? "",
        "<Delimiter>&#x0A;</Delimiter>",
      );
      // start-after shares the same echo path (startafter_unreadable).
      await client.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          StartAfter: "a\nb",
        }),
      );
      assertStringIncludes(
        context.lastRawBody() ?? "",
        "<StartAfter>a&#x0A;b</StartAfter>",
      );
    },
  },
  {
    name: "listing/encoding-url-v1",
    config: testConfig,
    skipSnapshot: true,
    // Regression: s3-tests test_bucket_list_encoding_basic requires keys and
    // common prefixes to be percent-encoded and <EncodingType>url</EncodingType>
    // emitted when encoding-type=url is requested. botocore leaves the values
    // encoded when the customer explicitly requested the encoding, so the
    // parsed values are the encoded forms.
    beforeAll: (c) =>
      putKeys(c, ["foo+1/bar", "foo/bar/xyzzy", "quux ab/thud", "asdf+b"]),
    afterAll: (c) =>
      deleteKeys(c, ["foo+1/bar", "foo/bar/xyzzy", "quux ab/thud", "asdf+b"]),
    fn: async (client, context) => {
      if (!context) throw new Error("context required");
      const r = await client.send(
        new ListObjectsCommand({
          Bucket: BUCKET,
          Delimiter: "/",
          EncodingType: "url",
        }),
      );
      assertEquals(r.Delimiter, "/");
      assertEquals(getKeys(r), ["asdf%2Bb"]);
      assertEquals(getPrefixes(r), ["foo%2B1/", "foo/", "quux%20ab/"]);
      assertStringIncludes(
        context.lastRawBody() ?? "",
        "<EncodingType>url</EncodingType>",
      );
    },
  },
  {
    name: "listing/encoding-url-v2",
    config: testConfig,
    skipSnapshot: true,
    // Regression: s3-tests test_bucket_listv2_encoding_basic (same expectations
    // as the v1 case, via ListObjectsV2).
    beforeAll: (c) =>
      putKeys(c, ["foo+1/bar", "foo/bar/xyzzy", "quux ab/thud", "asdf+b"]),
    afterAll: (c) =>
      deleteKeys(c, ["foo+1/bar", "foo/bar/xyzzy", "quux ab/thud", "asdf+b"]),
    fn: async (client, context) => {
      if (!context) throw new Error("context required");
      const r = await client.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          Delimiter: "/",
          EncodingType: "url",
        }),
      );
      assertEquals(r.Delimiter, "/");
      assertEquals(getKeys(r), ["asdf%2Bb"]);
      assertEquals(getPrefixes(r), ["foo%2B1/", "foo/", "quux%20ab/"]);
      assertStringIncludes(
        context.lastRawBody() ?? "",
        "<EncodingType>url</EncodingType>",
      );
    },
  },
  {
    name: "listing/encoding-url-versions",
    config: testConfig,
    skipSnapshot: true,
    // ListObjectVersions must encode keys the same way when encoding-type=url
    // is requested (s3-tests test_object_copy_versioned_url_encoding family).
    beforeAll: (c) => putKeys(c, ["asdf+b"]),
    afterAll: (c) => deleteKeys(c, ["asdf+b"]),
    fn: async (client, context) => {
      if (!context) throw new Error("context required");
      const r = await client.send(
        new ListObjectVersionsCommand({ Bucket: BUCKET, EncodingType: "url" }),
      );
      const keys = (r.Versions ?? []).map((v) => v.Key);
      assertEquals(keys, ["asdf%2Bb"]);
      assertStringIncludes(
        context.lastRawBody() ?? "",
        "<EncodingType>url</EncodingType>",
      );
    },
  },
  {
    name: "listing/encoding-url-negative",
    config: testConfig,
    skipSnapshot: true,
    // Without encoding-type=url the response must stay byte-identical to
    // before: raw keys and no <EncodingType> element.
    beforeAll: (c) => putKeys(c, ["asdf+b", "quux ab"]),
    afterAll: (c) => deleteKeys(c, ["asdf+b", "quux ab"]),
    fn: async (client, context) => {
      if (!context) throw new Error("context required");
      const r = await client.send(
        new ListObjectsCommand({ Bucket: BUCKET }),
      );
      assertEquals(getKeys(r), ["asdf+b", "quux ab"]);
      const raw = context.lastRawBody() ?? "";
      assert(!raw.includes("<EncodingType>"), "no EncodingType element");
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
