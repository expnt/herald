import { Effect, Option, Stream } from "effect";
import {
  type BackendError,
  type BackendService,
  BucketAlreadyExists,
  BucketAlreadyOwnedByYou,
  type BucketInfo,
  BucketNotEmpty,
  type CommonPrefix,
  type DeleteObjectsResult,
  type HeadObjectResult,
  InternalError,
  type ListObjectsResult,
  NoSuchBucket,
  NoSuchKey,
  type ObjectInfo,
  type ObjectResponse,
  type OwnerInfo,
  type PutObjectResult,
} from "../../Services/Backend.ts";
import type { MaterializedBucket } from "../../Domain/Config.ts";
import { SwiftClient } from "./Client.ts";
import { fixHeaderEncoding } from "../../Frontend/Utils.ts";

interface SwiftContainer {
  readonly name: string;
  readonly last_modified?: string;
}

interface SwiftObject {
  readonly name?: string;
  readonly hash?: string;
  readonly bytes?: number;
  readonly content_type?: string;
  readonly last_modified?: string;
  readonly subdir?: string;
}

export const makeSwiftBackend = (
  bucket: MaterializedBucket | { backend_id: string },
): Effect.Effect<BackendService, never, SwiftClient> =>
  Effect.gen(function* () {
    const swiftClient = yield* SwiftClient;

    const getTarget = () =>
      Effect.gen(function* () {
        const auth = yield* swiftClient.getAuthMeta(bucket).pipe(
          Effect.mapError((e) => new InternalError({ message: e.message })),
        );
        const container = "bucket_name" in bucket ? bucket.bucket_name : "";
        const encodedContainer = container ? encodeURIComponent(container) : "";
        return {
          storageUrl: auth.storageUrl,
          token: auth.token,
          container,
          url: encodedContainer
            ? `${auth.storageUrl}/${encodedContainer}`
            : auth.storageUrl,
        };
      });

    const mapError = (
      status: number,
      message: string,
      bucketName: string,
      method?: string,
      key?: string,
    ): BackendError => {
      switch (status) {
        case 404:
          if (key) {
            return new NoSuchKey({ bucketName, key, message });
          }
          return new NoSuchBucket({ bucketName, message });
        case 409:
          if (method === "DELETE") {
            return new BucketNotEmpty({ bucketName, message });
          }
          return new BucketAlreadyExists({ bucketName, message });
        case 202:
          if (method === "PUT") {
            return new BucketAlreadyOwnedByYou({ bucketName, message });
          }
          return new InternalError({
            message: `Swift error (${status}): ${message}`,
          });
        default:
          return new InternalError({
            message: `Swift error (${status}): ${message}`,
          });
      }
    };

    const listObjects = (args: {
      prefix?: string;
      delimiter?: string;
      marker?: string;
      maxKeys?: number;
      encodingType?: string;
      continuationToken?: string;
      startAfter?: string;
      listType?: 1 | 2;
    }) =>
      Effect.gen(function* () {
        const { url, token, container } = yield* getTarget();
        const limit = args.maxKeys ?? 1000;
        const query = new URLSearchParams({ format: "json" });
        if (args.prefix) query.set("prefix", args.prefix);
        if (args.delimiter) query.set("delimiter", args.delimiter);
        if (args.marker) query.set("marker", args.marker);
        query.set("limit", String(limit + 1));
        if (args.continuationToken) query.set("marker", args.continuationToken);
        if (args.startAfter) query.set("marker", args.startAfter);

        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(`${url}?${query.toString()}`, {
              headers: { "X-Auth-Token": token },
            }),
          catch: (e) => new InternalError({ message: String(e) }),
        });

        yield* Effect.logDebug(
          `Swift listObjects query=[${query.toString()}] status=${response.status}`,
        );

        if (!response.ok) {
          return yield* Effect.fail(
            mapError(response.status, response.statusText, container, "GET"),
          );
        }

        const rawObjects = (yield* Effect.tryPromise({
          try: () => response.json(),
          catch: (e) =>
            new InternalError({
              message: `Failed to parse Swift response: ${e}`,
            }),
        })) as readonly SwiftObject[];

        const isTruncated = rawObjects.length > limit;
        const objects = isTruncated ? rawObjects.slice(0, limit) : rawObjects;

        const contents: ObjectInfo[] = [];
        const commonPrefixes: CommonPrefix[] = [];

        for (const obj of objects) {
          if (obj.subdir) {
            commonPrefixes.push({ prefix: obj.subdir });
          } else if (obj.name) {
            contents.push({
              key: obj.name,
              lastModified: obj.last_modified
                ? new Date(obj.last_modified)
                : new Date(),
              etag: obj.hash ? `"${obj.hash}"` : "",
              size: obj.bytes ?? 0,
              storageClass: "STANDARD",
              owner: { id: "swift", displayName: "Swift User" },
            });
          }
        }

        const nextMarker = isTruncated && objects.length > 0
          ? objects[objects.length - 1].name ||
            objects[objects.length - 1].subdir
          : undefined;

        return {
          name: container,
          prefix: args.prefix,
          maxKeys: limit,
          delimiter: args.delimiter,
          isTruncated,
          marker: args.marker,
          nextMarker,
          contents,
          commonPrefixes,
          encodingType: args.encodingType,
          listType: args.listType ?? 1,
          nextContinuationToken: args.listType === 2 ? nextMarker : undefined,
          keyCount: contents.length + commonPrefixes.length,
        } satisfies ListObjectsResult;
      });

    return {
      listBuckets: () =>
        Effect.gen(function* () {
          const { storageUrl, token } = yield* getTarget();
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(`${storageUrl}?format=json`, {
                headers: { "X-Auth-Token": token },
              }),
            catch: (e) => new InternalError({ message: String(e) }),
          });

          if (!response.ok) {
            return yield* Effect.fail(
              mapError(response.status, response.statusText, "", "GET"),
            );
          }

          const buckets = (yield* Effect.tryPromise({
            try: () => response.json(),
            catch: (e) =>
              new InternalError({
                message: `Failed to parse Swift response: ${e}`,
              }),
          })) as readonly SwiftContainer[];

          const bucketInfos: BucketInfo[] = buckets.map((b) => ({
            name: b.name,
            creationDate: b.last_modified
              ? new Date(b.last_modified)
              : undefined,
          }));

          const owner: OwnerInfo = { id: "swift", displayName: "Swift User" };

          return { buckets: bucketInfos, owner };
        }),

      createBucket: () =>
        Effect.gen(function* () {
          const { url, token, container } = yield* getTarget();
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(url, {
                method: "PUT",
                headers: { "X-Auth-Token": token },
              }),
            catch: (e) => new InternalError({ message: String(e) }),
          });

          if (response.status === 201) {
            return yield* Effect.void;
          }

          if (response.status === 202) {
            return yield* Effect.fail(
              new BucketAlreadyOwnedByYou({
                bucketName: container,
                message: "Bucket already exists",
              }),
            );
          }

          if (!response.ok) {
            return yield* Effect.fail(
              mapError(response.status, response.statusText, container, "PUT"),
            );
          }

          return yield* Effect.void;
        }),

      deleteBucket: () =>
        Effect.gen(function* () {
          const { url, token, container } = yield* getTarget();
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(url, {
                method: "DELETE",
                headers: { "X-Auth-Token": token },
              }),
            catch: (e) => new InternalError({ message: String(e) }),
          });

          yield* Effect.logDebug(
            `Swift deleteBucket container=[${container}] status=${response.status}`,
          );

          if (response.status === 204) {
            return yield* Effect.void;
          }

          if (!response.ok) {
            return yield* Effect.fail(
              mapError(
                response.status,
                response.statusText,
                container,
                "DELETE",
              ),
            );
          }

          return yield* Effect.void;
        }),

      headBucket: () =>
        Effect.gen(function* () {
          const { url, token, container } = yield* getTarget();
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(url, {
                method: "HEAD",
                headers: { "X-Auth-Token": token },
              }),
            catch: (e) => new InternalError({ message: String(e) }),
          });

          if (!response.ok) {
            return yield* Effect.fail(
              mapError(response.status, response.statusText, container, "HEAD"),
            );
          }

          return yield* Effect.void;
        }),

      listObjects,

      listVersions: (args) =>
        Effect.gen(function* () {
          const result = yield* listObjects({
            prefix: args.prefix,
            delimiter: args.delimiter,
            marker: args.keyMarker,
            maxKeys: args.maxKeys,
          });
          return {
            ...result,
            contents: result.contents.map((c) => ({
              ...c,
              versionId: "null",
              isLatest: true,
            })),
          };
        }),

      getObject: (key: string) =>
        Effect.gen(function* () {
          const { url, token, container } = yield* getTarget();
          const encodedKey = key.split("/").map(encodeURIComponent).join("/");
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(`${url}/${encodedKey}`, {
                headers: { "X-Auth-Token": token },
              }),
            catch: (e) => new InternalError({ message: String(e) }),
          });

          if (!response.ok) {
            return yield* Effect.fail(
              mapError(
                response.status,
                response.statusText,
                container,
                "GET",
                key,
              ),
            );
          }

          const metadata: Record<string, string> = {};
          const s3Headers: Record<string, string> = {};
          response.headers.forEach((v, k) => {
            const lowK = k.toLowerCase();
            if (lowK.startsWith("x-object-meta-")) {
              const metaKey = lowK.substring("x-object-meta-".length);
              const value = (v.includes("%"))
                ? Option.liftThrowable(decodeURIComponent)(v).pipe(
                  Option.getOrElse(() => v),
                )
                : v;
              metadata[metaKey] = value;
              s3Headers[`x-amz-meta-${metaKey}`] = value;
            } else if (lowK === "content-type") {
              s3Headers["Content-Type"] = v;
            } else if (lowK === "content-length") {
              s3Headers["Content-Length"] = v;
            } else if (lowK === "etag") {
              s3Headers["ETag"] = v;
            } else if (lowK === "last-modified") {
              s3Headers["Last-Modified"] = v;
            }
          });

          return {
            stream: Stream.fromReadableStream(
              () => response.body!,
              (e) => new InternalError({ message: String(e) }),
            ),
            contentType: response.headers.get("Content-Type") || undefined,
            contentLength: parseInt(
              response.headers.get("Content-Length") || "0",
            ),
            etag: response.headers.get("ETag") || undefined,
            lastModified: response.headers.get("Last-Modified")
              ? new Date(response.headers.get("Last-Modified")!)
              : undefined,
            metadata,
            headers: s3Headers,
          } satisfies ObjectResponse;
        }),

      headObject: (key: string) =>
        Effect.gen(function* () {
          const { url, token, container } = yield* getTarget();
          const encodedKey = key.split("/").map(encodeURIComponent).join("/");
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(`${url}/${encodedKey}`, {
                method: "HEAD",
                headers: { "X-Auth-Token": token },
              }),
            catch: (e) => new InternalError({ message: String(e) }),
          });

          if (!response.ok) {
            return yield* Effect.fail(
              mapError(
                response.status,
                response.statusText,
                container,
                "HEAD",
                key,
              ),
            );
          }

          const metadata: Record<string, string> = {};
          const s3Headers: Record<string, string> = {};
          response.headers.forEach((v, k) => {
            const lowK = k.toLowerCase();
            if (lowK.startsWith("x-object-meta-")) {
              const metaKey = lowK.substring("x-object-meta-".length);
              const value = (v.includes("%"))
                ? Option.liftThrowable(decodeURIComponent)(v).pipe(
                  Option.getOrElse(() => v),
                )
                : v;
              metadata[metaKey] = value;
              s3Headers[`x-amz-meta-${metaKey}`] = value;
            } else if (lowK === "content-type") {
              s3Headers["Content-Type"] = v;
            } else if (lowK === "content-length") {
              s3Headers["Content-Length"] = v;
            } else if (lowK === "etag") {
              s3Headers["ETag"] = v;
            } else if (lowK === "last-modified") {
              s3Headers["Last-Modified"] = v;
            }
          });

          return {
            contentType: response.headers.get("Content-Type") || undefined,
            contentLength: parseInt(
              response.headers.get("Content-Length") || "0",
            ),
            etag: response.headers.get("ETag") || undefined,
            lastModified: response.headers.get("Last-Modified")
              ? new Date(response.headers.get("Last-Modified")!)
              : undefined,
            metadata,
            headers: s3Headers,
          } satisfies HeadObjectResult;
        }),

      putObject: (key, stream, headers) =>
        Effect.gen(function* () {
          const { url, token, container } = yield* getTarget();
          const encodedKey = key.split("/").map(encodeURIComponent).join("/");
          const contentLength = headers["content-length"] ||
            headers["Content-Length"];

          const swiftHeaders: Record<string, string> = {
            "X-Auth-Token": token,
            "Content-Type":
              (headers["content-type"] || headers["Content-Type"] ||
                "application/octet-stream") as string,
            ...(contentLength
              ? { "Content-Length": String(contentLength) }
              : {}),
          };

          for (const [k, v] of Object.entries(headers)) {
            const lowK = k.toLowerCase();
            if (lowK.startsWith("x-amz-meta-")) {
              const metaKey = lowK.substring("x-amz-meta-".length);
              const value = fixHeaderEncoding(String(v));
              swiftHeaders[`X-Object-Meta-${metaKey}`] =
                /[^\x20-\x7E]/.test(value) ? encodeURIComponent(value) : value;
            }
          }

          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(`${url}/${encodedKey}`, {
                method: "PUT",
                headers: swiftHeaders,
                body: Stream.toReadableStream(stream),
                // @ts-ignore: duplex is required for streaming body in fetch
                duplex: "half",
              }),
            catch: (e) => new InternalError({ message: String(e) }),
          });
          yield* Effect.logDebug(
            `Swift putObject key=[${key}] status=${response.status}`,
          );

          if (!response.ok) {
            return yield* Effect.fail(
              mapError(
                response.status,
                response.statusText,
                container,
                "PUT",
                key,
              ),
            );
          }

          return {
            etag: response.headers.get("ETag") || undefined,
          } satisfies PutObjectResult;
        }),

      deleteObject: (key: string) =>
        Effect.gen(function* () {
          const { url, token, container } = yield* getTarget();
          const encodedKey = key.split("/").map(encodeURIComponent).join("/");
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(`${url}/${encodedKey}`, {
                method: "DELETE",
                headers: { "X-Auth-Token": token },
              }),
            catch: (e) => new InternalError({ message: String(e) }),
          });

          if (!response.ok && response.status !== 204) {
            return yield* Effect.fail(
              mapError(
                response.status,
                response.statusText,
                container,
                "DELETE",
                key,
              ),
            );
          }

          return yield* Effect.void;
        }),

      deleteObjects: (objects) =>
        Effect.gen(function* () {
          const { url, token, container: _container } = yield* getTarget();
          const deleted: string[] = [];
          const errors: { key: string; code: string; message: string }[] = [];

          for (const obj of objects) {
            const encodedKey = obj.key.split("/").map(encodeURIComponent).join(
              "/",
            );
            const response = yield* Effect.tryPromise({
              try: () =>
                fetch(`${url}/${encodedKey}`, {
                  method: "DELETE",
                  headers: { "X-Auth-Token": token },
                }),
              catch: (e) => new InternalError({ message: String(e) }),
            });

            yield* Effect.logDebug(
              `Swift deleteObject key=[${obj.key}] status=${response.status}`,
            );

            if (
              response.ok || response.status === 204 || response.status === 404
            ) {
              deleted.push(obj.key);
            } else {
              const errorBody = yield* Effect.tryPromise(() => response.text())
                .pipe(
                  Effect.orElseSucceed(() => "Unknown error"),
                );
              errors.push({
                key: obj.key,
                code: String(response.status),
                message: errorBody,
              });
            }
          }

          return { deleted, errors } satisfies DeleteObjectsResult;
        }),
    };
  });
