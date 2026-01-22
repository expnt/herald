import {
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  ListBucketsCommand,
} from "@aws-sdk/client-s3";
import { type BenchmarkCase, benchmarkHarness } from "./utils.ts";
import type { GlobalConfig } from "../src/Domain/Config.ts";

const benchConfig: GlobalConfig = {
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

const BUCKET_PREFIX = "bench-bucket-";

const cases: BenchmarkCase[] = [
  {
    name: "create/new",
    group: "buckets",
    config: benchConfig,
    fn: async (client, b) => {
      const bucketName = `${BUCKET_PREFIX}${
        Math.random().toString(36).substring(7)
      }`;
      b.start();
      await client.send(new CreateBucketCommand({ Bucket: bucketName }));
      b.end();
      // Cleanup after measurement
      await client.send(new DeleteBucketCommand({ Bucket: bucketName })).catch(
        () => {},
      );
    },
  },
  {
    name: "list/all",
    group: "buckets",
    config: benchConfig,
    fn: async (client, b) => {
      b.start();
      await client.send(new ListBucketsCommand({}));
      b.end();
    },
  },
  {
    name: "head/existing",
    group: "buckets",
    config: benchConfig,
    setup: async (client) => {
      await client.send(new CreateBucketCommand({ Bucket: "head-bucket" }))
        .catch(() => {});
    },
    fn: async (client, b) => {
      b.start();
      await client.send(new HeadBucketCommand({ Bucket: "head-bucket" }));
      b.end();
    },
  },
  {
    name: "delete/existing",
    group: "buckets",
    config: benchConfig,
    fn: async (client, b) => {
      const bucketName = `delete-${Math.random().toString(36).substring(7)}`;
      await client.send(new CreateBucketCommand({ Bucket: bucketName }));
      b.start();
      await client.send(new DeleteBucketCommand({ Bucket: bucketName }));
      b.end();
    },
  },
];

benchmarkHarness(cases);
