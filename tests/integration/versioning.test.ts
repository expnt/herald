import { assertEquals } from "@std/assert";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  GetBucketVersioningCommand,
  PutBucketTaggingCommand,
  PutBucketVersioningCommand,
  S3ServiceException,
} from "@aws-sdk/client-s3";
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

const BUCKET = "test-versioning-dispatch";

const cases: ProxyTestCase[] = [
  {
    name: "versioning/get/fresh-bucket-empty-config",
    config: testConfig,
    beforeAll: async (client) => {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    },
    fn: async (client) => {
      // S3 semantics: a bucket that never had versioning configured returns
      // an empty <VersioningConfiguration/> (no Status field).
      const out = await client.send(
        new GetBucketVersioningCommand({ Bucket: BUCKET }),
      );
      assertEquals(out.Status, undefined);
    },
    afterAll: async (client) => {
      try {
        await client.send(new DeleteBucketCommand({ Bucket: BUCKET }));
      } catch {
        /* ignore */
      }
    },
    ignoreBaseline: true,
    skipSnapshot: true,
  },
  {
    name: "versioning/put-get/roundtrip-enabled-suspended",
    config: testConfig,
    beforeAll: async (client) => {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    },
    fn: async (client) => {
      await client.send(
        new PutBucketVersioningCommand({
          Bucket: BUCKET,
          VersioningConfiguration: { Status: "Enabled" },
        }),
      );
      const enabled = await client.send(
        new GetBucketVersioningCommand({ Bucket: BUCKET }),
      );
      assertEquals(enabled.Status, "Enabled");

      await client.send(
        new PutBucketVersioningCommand({
          Bucket: BUCKET,
          VersioningConfiguration: { Status: "Suspended" },
        }),
      );
      const suspended = await client.send(
        new GetBucketVersioningCommand({ Bucket: BUCKET }),
      );
      assertEquals(suspended.Status, "Suspended");
    },
    afterAll: async (client) => {
      try {
        await client.send(new DeleteBucketCommand({ Bucket: BUCKET }));
      } catch {
        /* ignore */
      }
    },
    ignoreBaseline: true,
    skipSnapshot: true,
  },
  {
    name: "versioning/put/bucket-not-found",
    config: testConfig,
    fn: async (client) => {
      const error = await client
        .send(
          new PutBucketVersioningCommand({
            Bucket: "test-versioning-no-such-bucket",
            VersioningConfiguration: { Status: "Enabled" },
          }),
        )
        .catch((e: unknown) => e as S3ServiceException);
      assertEquals(error instanceof S3ServiceException, true);
      assertEquals((error as S3ServiceException).name, "NoSuchBucket");
    },
    ignoreBaseline: true,
    skipSnapshot: true,
  },
  {
    name: "subresources/stubbed-tagging-returns-not-implemented",
    config: testConfig,
    beforeAll: async (client) => {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    },
    fn: async (client) => {
      // Before subresource dispatch this fell through to createBucket and
      // returned a spurious BucketAlreadyOwnedByYou; it must now be a 501.
      const error = await client
        .send(
          new PutBucketTaggingCommand({
            Bucket: BUCKET,
            Tagging: { TagSet: [{ Key: "k", Value: "v" }] },
          }),
        )
        .catch((e: unknown) => e as S3ServiceException);
      assertEquals(error instanceof S3ServiceException, true);
      const s3Error = error as S3ServiceException;
      assertEquals(s3Error.name, "NotImplemented");
      assertEquals(s3Error.$metadata.httpStatusCode, 501);
    },
    afterAll: async (client) => {
      try {
        await client.send(new DeleteBucketCommand({ Bucket: BUCKET }));
      } catch {
        /* ignore */
      }
    },
    ignoreBaseline: true,
    skipSnapshot: true,
  },
];

harness(cases);
