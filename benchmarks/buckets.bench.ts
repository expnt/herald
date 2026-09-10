import {
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  ListBucketsCommand,
} from "@aws-sdk/client-s3";
import { type BenchmarkCase, benchmarkHarness } from "./utils.ts";
import type { GlobalConfig } from "../src/Domain/Config.ts";
import { Effect } from "effect";
import { HttpClientRequest } from "@effect/platform";

const benchConfig: GlobalConfig = {
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
    directSwiftFn: async (target, client, b) => {
      const { url, token } = target;
      const bucketName = `${BUCKET_PREFIX}${
        Math.random().toString(36).substring(7)
      }`;
      b.start();
      const request = HttpClientRequest.put(`${url}/${bucketName}`).pipe(
        HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
      );
      await Effect.runPromise(client.execute(request));
      b.end();
      // Cleanup
      const delReq = HttpClientRequest.del(`${url}/${bucketName}`).pipe(
        HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
      );
      await Effect.runPromise(client.execute(delReq)).catch(() => {});
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
    directSwiftFn: async (target, client, b) => {
      const { url, token } = target;
      b.start();
      const request = HttpClientRequest.get(`${url}?format=json`).pipe(
        HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
      );
      await Effect.runPromise(client.execute(request));
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
    teardown: async (client) => {
      await client.send(new DeleteBucketCommand({ Bucket: "head-bucket" }))
        .catch(() => {});
    },
    directSwiftFn: async (target, client, b) => {
      const { url, token } = target;
      b.start();
      const request = HttpClientRequest.head(`${url}/head-bucket`).pipe(
        HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
      );
      await Effect.runPromise(client.execute(request));
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
    directSwiftFn: async (target, client, b) => {
      const { url, token } = target;
      const bucketName = `delete-${Math.random().toString(36).substring(7)}`;
      // Setup
      const putReq = HttpClientRequest.put(`${url}/${bucketName}`).pipe(
        HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
      );
      await Effect.runPromise(client.execute(putReq));

      b.start();
      const request = HttpClientRequest.del(`${url}/${bucketName}`).pipe(
        HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
      );
      await Effect.runPromise(client.execute(request));
      b.end();
    },
  },
];

benchmarkHarness(cases);
