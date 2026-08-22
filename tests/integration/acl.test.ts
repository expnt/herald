import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetBucketAclCommand,
  GetObjectAclCommand,
  PutBucketAclCommand,
  PutObjectAclCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { assert, assertEquals, harness, type ProxyTestCase } from "../utils.ts";
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

const BUCKET = "test-acl-bucket";
const KEY = "acl-key";

const ALL_USERS_URI = "http://acs.amazonaws.com/groups/global/AllUsers";

const findGrant = (
  grants: {
    Grantee?: { Type?: string; URI?: string; ID?: string };
    Permission?: string;
  }[],
  predicate: (
    g: {
      Grantee?: { Type?: string; URI?: string; ID?: string };
      Permission?: string;
    },
  ) => boolean,
) => grants.find(predicate);

const assertOwnerFullControl = (
  grants: {
    Grantee?: { Type?: string; URI?: string; ID?: string };
    Permission?: string;
  }[],
) => {
  assertEquals(grants.length, 1, "expected exactly one grant for private ACL");
  const grant = grants[0];
  assertEquals(grant.Permission, "FULL_CONTROL");
  assertEquals(grant.Grantee?.Type, "CanonicalUser");
  assert(
    grant.Grantee?.ID !== undefined && grant.Grantee.ID !== "",
    "owner grant must carry a canonical ID",
  );
};

const assertPublicRead = (
  grants: {
    Grantee?: { Type?: string; URI?: string; ID?: string };
    Permission?: string;
  }[],
) => {
  const allUsersRead = findGrant(
    grants,
    (g) =>
      g.Grantee?.Type === "Group" &&
      g.Grantee?.URI === ALL_USERS_URI &&
      g.Permission === "READ",
  );
  assert(allUsersRead !== undefined, "expected AllUsers READ grant");
  const ownerFull = findGrant(
    grants,
    (g) =>
      g.Grantee?.Type === "CanonicalUser" && g.Permission === "FULL_CONTROL",
  );
  assert(ownerFull !== undefined, "expected owner FULL_CONTROL grant");
};

interface AclTestSpec {
  name: string;
  fn: (client: S3Client) => Promise<void>;
  /** MinIO's native ACL support is a stub; ACL semantics live in the proxy. */
  ignoreBaseline?: boolean;
}

const specs: AclTestSpec[] = [
  {
    name: "acl/bucket/default",
    ignoreBaseline: true,
    fn: async (c) => {
      const response = await c.send(
        new GetBucketAclCommand({ Bucket: BUCKET }),
      );
      assert(
        response.Owner?.ID !== undefined && response.Owner.ID !== "",
        "owner ID must be present",
      );
      assertOwnerFullControl(response.Grants ?? []);
    },
  },
  {
    name: "acl/bucket/canned-public-read",
    ignoreBaseline: true,
    fn: async (c) => {
      await c.send(
        new PutBucketAclCommand({ Bucket: BUCKET, ACL: "public-read" }),
      );
      const response = await c.send(
        new GetBucketAclCommand({ Bucket: BUCKET }),
      );
      assertPublicRead(response.Grants ?? []);
    },
  },
  {
    name: "acl/bucket/canned-roundtrip",
    ignoreBaseline: true,
    fn: async (c) => {
      await c.send(
        new PutBucketAclCommand({ Bucket: BUCKET, ACL: "public-read" }),
      );
      await c.send(new PutBucketAclCommand({ Bucket: BUCKET, ACL: "private" }));
      const response = await c.send(
        new GetBucketAclCommand({ Bucket: BUCKET }),
      );
      assertOwnerFullControl(response.Grants ?? []);
    },
  },
  {
    name: "acl/bucket/canned-during-create",
    ignoreBaseline: true,
    fn: async (c) => {
      // The harness beforeAll already created the bucket without an ACL;
      // simulate creation-time ACL by setting it and verifying persistence.
      await c.send(
        new PutBucketAclCommand({ Bucket: BUCKET, ACL: "public-read" }),
      );
      const response = await c.send(
        new GetBucketAclCommand({ Bucket: BUCKET }),
      );
      assertPublicRead(response.Grants ?? []);
    },
  },
  {
    name: "acl/object/default",
    ignoreBaseline: true,
    fn: async (c) => {
      await c.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: KEY, Body: "bar" }),
      );
      const response = await c.send(
        new GetObjectAclCommand({ Bucket: BUCKET, Key: KEY }),
      );
      assert(
        response.Owner?.ID !== undefined && response.Owner.ID !== "",
        "owner ID must be present",
      );
      assertOwnerFullControl(response.Grants ?? []);
    },
  },
  {
    name: "acl/object/canned-during-create",
    ignoreBaseline: true,
    fn: async (c) => {
      await c.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: KEY,
          Body: "bar",
          ACL: "public-read",
        }),
      );
      const response = await c.send(
        new GetObjectAclCommand({ Bucket: BUCKET, Key: KEY }),
      );
      assertPublicRead(response.Grants ?? []);
    },
  },
  {
    name: "acl/object/canned-roundtrip",
    ignoreBaseline: true,
    fn: async (c) => {
      await c.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: KEY,
          Body: "bar",
          ACL: "public-read",
        }),
      );
      await c.send(
        new PutObjectAclCommand({ Bucket: BUCKET, Key: KEY, ACL: "private" }),
      );
      const response = await c.send(
        new GetObjectAclCommand({ Bucket: BUCKET, Key: KEY }),
      );
      assertOwnerFullControl(response.Grants ?? []);
    },
  },
];

const cases: ProxyTestCase[] = specs.map((spec) => ({
  name: spec.name,
  config: testConfig,
  beforeAll: async (client: S3Client) => {
    try {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    } catch { /* ignore if already exists */ }
  },
  afterAll: async (client: S3Client) => {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: KEY }));
    } catch { /* ignore */ }
    try {
      await client.send(new DeleteBucketCommand({ Bucket: BUCKET }));
    } catch { /* ignore */ }
  },
  fn: (client: S3Client) => spec.fn(client),
  skipSnapshot: true,
  ignoreBaseline: spec.ignoreBaseline,
}));

harness(cases);
