import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { type BenchmarkCase, benchmarkHarness } from "./utils.ts";
import type { GlobalConfig } from "../src/Domain/Config.ts";
import { Effect, Stream } from "effect";
import { HttpClientRequest } from "@effect/platform";

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

const BUCKET = "bench-bucket-objects";
const DATA_1KB = new Uint8Array(1024).fill(97);
const DATA_1MB = new Uint8Array(1024 * 1024).fill(97);
const DATA_10MB = new Uint8Array(10 * 1024 * 1024).fill(97);

const getLargeData = (sizeMb: number) =>
  new Uint8Array(sizeMb * 1024 * 1024).fill(97);

const cases: BenchmarkCase[] = [
  // --- PutObject ---
  {
    name: "put/1kb",
    group: "objects",
    config: benchConfig,
    setup: async (client) => {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(
        () => {},
      );
    },
    fn: async (client, b) => {
      b.start();
      await client.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: "1kb.txt",
          Body: DATA_1KB,
        }),
      );
      b.end();
    },
    teardown: async (client) => {
      await client.send(
        new DeleteObjectCommand({ Bucket: BUCKET, Key: "1kb.txt" }),
      ).catch(() => {});
    },
    directSwiftFn: async (target, client, b) => {
      const { url, token } = target;
      b.start();
      const request = HttpClientRequest.put(`${url}/${BUCKET}/1kb.txt`).pipe(
        HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
        HttpClientRequest.bodyUint8Array(DATA_1KB),
      );
      const response = await Effect.runPromise(client.execute(request));
      await response.text; // Ensure body is consumed
      b.end();
    },
  },
  {
    name: "put/1mb",
    group: "objects",
    config: benchConfig,
    setup: async (client) => {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(
        () => {},
      );
    },
    fn: async (client, b) => {
      b.start();
      await client.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: "1mb.txt",
          Body: DATA_1MB,
        }),
      );
      b.end();
    },
    teardown: async (client) => {
      await client.send(
        new DeleteObjectCommand({ Bucket: BUCKET, Key: "1mb.txt" }),
      ).catch(() => {});
    },
    directSwiftFn: async (target, client, b) => {
      const { url, token } = target;
      b.start();
      const request = HttpClientRequest.put(`${url}/${BUCKET}/1mb.txt`).pipe(
        HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
        HttpClientRequest.bodyUint8Array(DATA_1MB),
      );
      const response = await Effect.runPromise(client.execute(request));
      await response.text;
      b.end();
    },
  },
  {
    name: "put/10mb",
    group: "objects",
    config: benchConfig,
    setup: async (client) => {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(
        () => {},
      );
    },
    fn: async (client, b) => {
      b.start();
      await client.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: "10mb.txt",
          Body: DATA_10MB,
        }),
      );
      b.end();
    },
    teardown: async (client) => {
      await client.send(
        new DeleteObjectCommand({ Bucket: BUCKET, Key: "10mb.txt" }),
      ).catch(() => {});
    },
    directSwiftFn: async (target, client, b) => {
      const { url, token } = target;
      b.start();
      const request = HttpClientRequest.put(`${url}/${BUCKET}/10mb.txt`).pipe(
        HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
        HttpClientRequest.bodyUint8Array(DATA_10MB),
      );
      const response = await Effect.runPromise(client.execute(request));
      await response.text;
      b.end();
    },
  },
  {
    name: "put/100mb",
    group: "objects",
    config: benchConfig,
    setup: async (client) => {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(
        () => {},
      );
    },
    fn: async (client, b) => {
      const data = getLargeData(100);
      b.start();
      await client.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: "100mb.txt",
          Body: data,
        }),
      );
      b.end();
    },
    teardown: async (client) => {
      await client.send(
        new DeleteObjectCommand({ Bucket: BUCKET, Key: "100mb.txt" }),
      ).catch(() => {});
    },
    directSwiftFn: async (target, client, b) => {
      const { url, token } = target;
      const data = getLargeData(100);
      b.start();
      const request = HttpClientRequest.put(`${url}/${BUCKET}/100mb.txt`).pipe(
        HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
        HttpClientRequest.bodyUint8Array(data),
      );
      const response = await Effect.runPromise(client.execute(request));
      await response.text;
      b.end();
    },
  },
  // --- HeadObject ---
  {
    name: "get/1kb",
    group: "objects",
    config: benchConfig,
    setup: async (client) => {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(
        () => {},
      );
      await client.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: "get-1kb.txt",
          Body: DATA_1KB,
        }),
      );
    },
    fn: async (client, b) => {
      b.start();
      const res = await client.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: "get-1kb.txt" }),
      );
      await res.Body?.transformToByteArray();
      b.end();
    },
    teardown: async (client) => {
      await client.send(
        new DeleteObjectCommand({ Bucket: BUCKET, Key: "get-1kb.txt" }),
      ).catch(() => {});
    },
    directSwiftFn: async (target, client, b) => {
      const { url, token } = target;
      b.start();
      const request = HttpClientRequest.get(`${url}/${BUCKET}/get-1kb.txt`)
        .pipe(
          HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
        );
      const response = await Effect.runPromise(client.execute(request));
      await Effect.runPromise(Stream.runDrain(response.stream));
      b.end();
    },
  },
  {
    name: "get/1mb",
    group: "objects",
    config: benchConfig,
    setup: async (client) => {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(
        () => {},
      );
      await client.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: "get-1mb.txt",
          Body: DATA_1MB,
        }),
      );
    },
    fn: async (client, b) => {
      b.start();
      const res = await client.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: "get-1mb.txt" }),
      );
      await res.Body?.transformToByteArray();
      b.end();
    },
    teardown: async (client) => {
      await client.send(
        new DeleteObjectCommand({ Bucket: BUCKET, Key: "get-1mb.txt" }),
      ).catch(() => {});
    },
    directSwiftFn: async (target, client, b) => {
      const { url, token } = target;
      b.start();
      const request = HttpClientRequest.get(`${url}/${BUCKET}/get-1mb.txt`)
        .pipe(
          HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
        );
      const response = await Effect.runPromise(client.execute(request));
      await Effect.runPromise(Stream.runDrain(response.stream));
      b.end();
    },
  },
  {
    name: "get/10mb",
    group: "objects",
    config: benchConfig,
    setup: async (client) => {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(
        () => {},
      );
      await client.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: "get-10mb.txt",
          Body: DATA_10MB,
        }),
      );
    },
    fn: async (client, b) => {
      b.start();
      const res = await client.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: "get-10mb.txt" }),
      );
      await res.Body?.transformToByteArray();
      b.end();
    },
    teardown: async (client) => {
      await client.send(
        new DeleteObjectCommand({ Bucket: BUCKET, Key: "get-10mb.txt" }),
      ).catch(() => {});
    },
    directSwiftFn: async (target, client, b) => {
      const { url, token } = target;
      b.start();
      const request = HttpClientRequest.get(`${url}/${BUCKET}/get-10mb.txt`)
        .pipe(
          HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
        );
      const response = await Effect.runPromise(client.execute(request));
      await Effect.runPromise(Stream.runDrain(response.stream));
      b.end();
    },
  },
  {
    name: "get/100mb",
    group: "objects",
    config: benchConfig,
    setup: async (client) => {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(
        () => {},
      );
      await client.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: "get-100mb.txt",
          Body: getLargeData(100),
        }),
      );
    },
    fn: async (client, b) => {
      b.start();
      const res = await client.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: "get-100mb.txt" }),
      );
      await res.Body?.transformToByteArray();
      b.end();
    },
    teardown: async (client) => {
      await client.send(
        new DeleteObjectCommand({ Bucket: BUCKET, Key: "get-100mb.txt" }),
      ).catch(() => {});
    },
    directSwiftFn: async (target, client, b) => {
      const { url, token } = target;
      b.start();
      const request = HttpClientRequest.get(`${url}/${BUCKET}/get-100mb.txt`)
        .pipe(
          HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
        );
      const response = await Effect.runPromise(client.execute(request));
      await Effect.runPromise(Stream.runDrain(response.stream));
      b.end();
    },
  },

  // --- HeadObject ---
  {
    name: "head/existing",
    group: "objects",
    config: benchConfig,
    setup: async (client) => {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(
        () => {},
      );
      await client.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: "head.txt",
          Body: DATA_1KB,
        }),
      );
    },
    fn: async (client, b) => {
      b.start();
      await client.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: "head.txt" }),
      );
      b.end();
    },
    directSwiftFn: async (target, client, b) => {
      const { url, token } = target;
      b.start();
      const request = HttpClientRequest.head(`${url}/${BUCKET}/head.txt`).pipe(
        HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
      );
      await Effect.runPromise(client.execute(request));
      b.end();
    },
  },

  // --- DeleteObject ---
  {
    name: "delete/existing",
    group: "objects",
    config: benchConfig,
    setup: async (client) => {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(
        () => {},
      );
    },
    fn: async (client, b) => {
      await client.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: "delete.txt",
          Body: DATA_1KB,
        }),
      );

      b.start();
      await client.send(
        new DeleteObjectCommand({ Bucket: BUCKET, Key: "delete.txt" }),
      );
      b.end();
    },
    directSwiftFn: async (target, client, b) => {
      const { url, token } = target;
      // Pre-upload for delete
      const putReq = HttpClientRequest.put(
        `${url}/${BUCKET}/delete-direct.txt`,
      ).pipe(
        HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
        HttpClientRequest.bodyUint8Array(DATA_1KB),
      );
      await Effect.runPromise(client.execute(putReq));

      b.start();
      const request = HttpClientRequest.del(
        `${url}/${BUCKET}/delete-direct.txt`,
      ).pipe(
        HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
      );
      await Effect.runPromise(client.execute(request));
      b.end();
    },
  },

  // --- Multipart Upload ---
  {
    name: "multipart/10mb",
    group: "objects",
    config: benchConfig,
    setup: async (client) => {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(
        () => {},
      );
    },
    fn: async (client, b) => {
      const key = "multipart-10mb.txt";
      const partSize = 5 * 1024 * 1024;
      const body = new Uint8Array(partSize).fill(97);

      b.start();
      const { UploadId } = await client.send(
        new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key }),
      );
      const { ETag: etag1 } = await client.send(
        new UploadPartCommand({
          Bucket: BUCKET,
          Key: key,
          UploadId,
          PartNumber: 1,
          Body: body,
        }),
      );
      const { ETag: etag2 } = await client.send(
        new UploadPartCommand({
          Bucket: BUCKET,
          Key: key,
          UploadId,
          PartNumber: 2,
          Body: body,
        }),
      );
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: BUCKET,
          Key: key,
          UploadId,
          MultipartUpload: {
            Parts: [
              { ETag: etag1, PartNumber: 1 },
              { ETag: etag2, PartNumber: 2 },
            ],
          },
        }),
      );
      b.end();
    },
    teardown: async (client) => {
      await client.send(
        new DeleteObjectCommand({ Bucket: BUCKET, Key: "multipart-10mb.txt" }),
      ).catch(() => {});
    },
  },
  {
    name: "multipart/100mb",
    group: "objects",
    config: benchConfig,
    setup: async (client) => {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(
        () => {},
      );
    },
    fn: async (client, b) => {
      const key = "multipart-100mb.txt";
      const partSize = 10 * 1024 * 1024;
      const body = new Uint8Array(partSize).fill(97);

      b.start();
      const { UploadId } = await client.send(
        new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key }),
      );

      const parts = await Promise.all(
        Array.from({ length: 10 }, (_, i) => i + 1).map(async (i) => {
          const { ETag } = await client.send(
            new UploadPartCommand({
              Bucket: BUCKET,
              Key: key,
              UploadId,
              PartNumber: i,
              Body: body,
            }),
          );
          return { ETag, PartNumber: i };
        }),
      );

      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: BUCKET,
          Key: key,
          UploadId,
          MultipartUpload: {
            Parts: parts,
          },
        }),
      );
      b.end();
    },
    teardown: async (client) => {
      await client.send(
        new DeleteObjectCommand({ Bucket: BUCKET, Key: "multipart-100mb.txt" }),
      ).catch(() => {});
    },
  },
];

benchmarkHarness(cases);
