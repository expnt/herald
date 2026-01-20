import { Effect, Option } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
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
): Effect.Effect<BackendService, never, SwiftClient | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const swiftClient = yield* SwiftClient;
    const client = yield* HttpClient.HttpClient;

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

        const response = yield* client.execute(
          HttpClientRequest.get(`${url}?${query.toString()}`).pipe(
            HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
          ),
        ).pipe(
          Effect.mapError((e) => new InternalError({ message: String(e) })),
        );

        yield* Effect.logDebug(
          `Swift listObjects query=[${query.toString()}] status=${response.status}`,
        );

        if (response.status < 200 || response.status >= 300) {
          const message = yield* response.text.pipe(
            Effect.orElseSucceed(() => "Error"),
          );
          return yield* Effect.fail(
            mapError(response.status, message || "Error", container, "GET"),
          );
        }

        const rawObjects = (yield* response.json.pipe(
          Effect.mapError((e) =>
            new InternalError({
              message: `Failed to parse Swift response: ${e}`,
            })
          ),
        )) as readonly SwiftObject[];

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
          const response = yield* client.execute(
            HttpClientRequest.get(`${storageUrl}?format=json`).pipe(
              HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
            ),
          ).pipe(
            Effect.mapError((e) => new InternalError({ message: String(e) })),
          );

          if (response.status < 200 || response.status >= 300) {
            const message = yield* response.text.pipe(
              Effect.orElseSucceed(() => "Error"),
            );
            return yield* Effect.fail(
              mapError(response.status, message || "Error", "", "GET"),
            );
          }

          const buckets = (yield* response.json.pipe(
            Effect.mapError((e) =>
              new InternalError({
                message: `Failed to parse Swift response: ${e}`,
              })
            ),
          )) as readonly SwiftContainer[];

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
          const response = yield* client.execute(
            HttpClientRequest.put(url).pipe(
              HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
            ),
          ).pipe(
            Effect.mapError((e) => new InternalError({ message: String(e) })),
          );

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

          if (response.status < 200 || response.status >= 300) {
            const message = yield* response.text.pipe(
              Effect.orElseSucceed(() => "Error"),
            );
            return yield* Effect.fail(
              mapError(response.status, message || "Error", container, "PUT"),
            );
          }

          return yield* Effect.void;
        }),

      deleteBucket: () =>
        Effect.gen(function* () {
          const { url, token, container } = yield* getTarget();
          const response = yield* client.execute(
            HttpClientRequest.del(url).pipe(
              HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
            ),
          ).pipe(
            Effect.mapError((e) => new InternalError({ message: String(e) })),
          );

          yield* Effect.logDebug(
            `Swift deleteBucket container=[${container}] status=${response.status}`,
          );

          if (response.status === 204) {
            return yield* Effect.void;
          }

          if (response.status < 200 || response.status >= 300) {
            const message = yield* response.text.pipe(
              Effect.orElseSucceed(() => "Error"),
            );
            return yield* Effect.fail(
              mapError(
                response.status,
                message || "Error",
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
          const response = yield* client.execute(
            HttpClientRequest.head(url).pipe(
              HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
            ),
          ).pipe(
            Effect.mapError((e) => new InternalError({ message: String(e) })),
          );

          if (response.status < 200 || response.status >= 300) {
            const message = yield* response.text.pipe(
              Effect.orElseSucceed(() => "Error"),
            );
            return yield* Effect.fail(
              mapError(response.status, message || "Error", container, "HEAD"),
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

      getObject: (
        key: string,
        headers: Record<string, string | string[] | undefined>,
      ) =>
        Effect.gen(function* () {
          const { url, token, container } = yield* getTarget();
          const encodedKey = key.split("/").map(encodeURIComponent).join("/");
          const swiftHeaders: Record<string, string> = {
            "X-Auth-Token": token,
          };
          if (headers["range"] || headers["Range"]) {
            swiftHeaders["Range"] = String(
              headers["range"] || headers["Range"],
            );
          }
          if (headers["if-match"] || headers["If-Match"]) {
            swiftHeaders["If-Match"] = String(
              headers["if-match"] ||
                headers["If-Match"],
            );
          }
          if (headers["if-none-match"] || headers["If-None-Match"]) {
            swiftHeaders["If-None-Match"] = String(
              headers["if-none-match"] ||
                headers["If-None-Match"],
            );
          }
          if (headers["if-modified-since"] || headers["If-Modified-Since"]) {
            swiftHeaders["If-Modified-Since"] = String(
              headers["if-modified-since"] ||
                headers["If-Modified-Since"],
            );
          }
          if (
            headers["if-unmodified-since"] || headers["If-Unmodified-Since"]
          ) {
            swiftHeaders["If-Unmodified-Since"] = String(
              headers["if-unmodified-since"] ||
                headers["If-Unmodified-Since"],
            );
          }

          const response = yield* client.execute(
            HttpClientRequest.get(`${url}/${encodedKey}`).pipe(
              HttpClientRequest.setHeaders(swiftHeaders),
            ),
          ).pipe(
            Effect.mapError((e) => new InternalError({ message: String(e) })),
          );

          if (response.status < 200 || response.status >= 300) {
            const message = yield* response.text.pipe(
              Effect.orElseSucceed(() => "Error"),
            );
            return yield* Effect.fail(
              mapError(
                response.status,
                message || "Error",
                container,
                "GET",
                key,
              ),
            );
          }

          const metadata: Record<string, string> = {};
          const s3Headers: Record<string, string> = {};

          // HttpClientResponse.headers is a Record<string, string | string[]>
          for (const [k, v] of Object.entries(response.headers)) {
            const lowK = k.toLowerCase();
            const value = Array.isArray(v) ? v.join(", ") : v;
            if (lowK.startsWith("x-object-meta-")) {
              const metaKey = lowK.substring("x-object-meta-".length);
              const decodedValue = (value.includes("%"))
                ? Option.liftThrowable(decodeURIComponent)(value).pipe(
                  Option.getOrElse(() => value),
                )
                : value;
              metadata[metaKey] = decodedValue;
              s3Headers[`x-amz-meta-${metaKey}`] = decodedValue;
            } else if (lowK === "content-type") {
              s3Headers["Content-Type"] = value;
            } else if (lowK === "content-length") {
              s3Headers["Content-Length"] = value;
            } else if (lowK === "etag") {
              s3Headers["ETag"] = value;
            } else if (lowK === "last-modified") {
              s3Headers["Last-Modified"] = value;
            }
          }

          const contentLengthHeader = response.headers["content-length"];
          const contentLength = Array.isArray(contentLengthHeader)
            ? parseInt(contentLengthHeader[0] || "0")
            : parseInt(contentLengthHeader || "0");

          const etagHeader = response.headers["etag"];
          const etag = Array.isArray(etagHeader) ? etagHeader[0] : etagHeader;

          const lastModifiedHeader = response.headers["last-modified"];
          const lastModified = Array.isArray(lastModifiedHeader)
            ? lastModifiedHeader[0]
            : lastModifiedHeader;

          return {
            stream: response.stream,
            contentType: (Array.isArray(response.headers["content-type"])
              ? response.headers["content-type"][0]
              : response.headers["content-type"]) || undefined,
            contentLength,
            etag: etag || undefined,
            lastModified: lastModified ? new Date(lastModified) : undefined,
            metadata,
            headers: s3Headers,
          } satisfies ObjectResponse;
        }),

      headObject: (
        key: string,
        _headers: Record<string, string | string[] | undefined>,
      ) =>
        Effect.gen(function* () {
          const { url, token, container } = yield* getTarget();
          const encodedKey = key.split("/").map(encodeURIComponent).join("/");
          const swiftHeaders: Record<string, string> = {
            "X-Auth-Token": token,
          };
          // ... handle headers if needed
          const response = yield* client.execute(
            HttpClientRequest.head(`${url}/${encodedKey}`).pipe(
              HttpClientRequest.setHeaders(swiftHeaders),
            ),
          ).pipe(
            Effect.mapError((e) => new InternalError({ message: String(e) })),
          );

          if (response.status < 200 || response.status >= 300) {
            const message = yield* response.text.pipe(
              Effect.orElseSucceed(() => "Error"),
            );
            return yield* Effect.fail(
              mapError(
                response.status,
                message || "Error",
                container,
                "HEAD",
                key,
              ),
            );
          }

          const metadata: Record<string, string> = {};
          const s3Headers: Record<string, string> = {};

          for (const [k, v] of Object.entries(response.headers)) {
            const lowK = k.toLowerCase();
            const value = Array.isArray(v) ? v.join(", ") : v;
            if (lowK.startsWith("x-object-meta-")) {
              const metaKey = lowK.substring("x-object-meta-".length);
              const decodedValue = (value.includes("%"))
                ? Option.liftThrowable(decodeURIComponent)(value).pipe(
                  Option.getOrElse(() => value),
                )
                : value;
              metadata[metaKey] = decodedValue;
              s3Headers[`x-amz-meta-${metaKey}`] = decodedValue;
            } else if (lowK === "content-type") {
              s3Headers["Content-Type"] = value;
            } else if (lowK === "content-length") {
              s3Headers["Content-Length"] = value;
            } else if (lowK === "etag") {
              s3Headers["ETag"] = value;
            } else if (lowK === "last-modified") {
              s3Headers["Last-Modified"] = value;
            }
          }

          const contentLengthHeader = response.headers["content-length"];
          const contentLength = Array.isArray(contentLengthHeader)
            ? parseInt(contentLengthHeader[0] || "0")
            : parseInt(contentLengthHeader || "0");

          const etagHeader = response.headers["etag"];
          const etag = Array.isArray(etagHeader) ? etagHeader[0] : etagHeader;

          const lastModifiedHeader = response.headers["last-modified"];
          const lastModified = Array.isArray(lastModifiedHeader)
            ? lastModifiedHeader[0]
            : lastModifiedHeader;

          return {
            contentType: (Array.isArray(response.headers["content-type"])
              ? response.headers["content-type"][0]
              : response.headers["content-type"]) || undefined,
            contentLength,
            etag: etag || undefined,
            lastModified: lastModified ? new Date(lastModified) : undefined,
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

          const request = HttpClientRequest.put(`${url}/${encodedKey}`).pipe(
            HttpClientRequest.setHeaders(swiftHeaders),
            HttpClientRequest.bodyStream(stream),
          );

          const response = yield* client.execute(request).pipe(
            Effect.mapError((e) => new InternalError({ message: String(e) })),
          );

          yield* Effect.logDebug(
            `Swift putObject key=[${key}] status=${response.status}`,
          );

          if (response.status < 200 || response.status >= 300) {
            const message = yield* response.text.pipe(
              Effect.orElseSucceed(() => "Error"),
            );
            return yield* Effect.fail(
              mapError(
                response.status,
                message || "Error",
                container,
                "PUT",
                key,
              ),
            );
          }

          const etagHeader = response.headers["etag"];
          const etagValue = Array.isArray(etagHeader)
            ? etagHeader[0]
            : etagHeader;

          return {
            etag: etagValue || undefined,
          } satisfies PutObjectResult;
        }),

      deleteObject: (key: string) =>
        Effect.gen(function* () {
          const { url, token, container } = yield* getTarget();
          const encodedKey = key.split("/").map(encodeURIComponent).join("/");
          const response = yield* client.execute(
            HttpClientRequest.del(`${url}/${encodedKey}`).pipe(
              HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
            ),
          ).pipe(
            Effect.mapError((e) => new InternalError({ message: String(e) })),
          );

          if (response.status < 200 || response.status >= 300) {
            if (response.status === 404) {
              return yield* Effect.void;
            }
            const message = yield* response.text.pipe(
              Effect.orElseSucceed(() => "Error"),
            );
            return yield* Effect.fail(
              mapError(
                response.status,
                message || "Error",
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
            const response = yield* client.execute(
              HttpClientRequest.del(`${url}/${encodedKey}`).pipe(
                HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
              ),
            ).pipe(
              Effect.mapError((e) => new InternalError({ message: String(e) })),
            );

            yield* Effect.logDebug(
              `Swift deleteObject key=[${obj.key}] status=${response.status}`,
            );

            if (
              (response.status >= 200 && response.status < 300) ||
              response.status === 204 || response.status === 404
            ) {
              deleted.push(obj.key);
            } else {
              const errorBody = yield* response.text.pipe(
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

      createMultipartUpload: (_key, _headers) =>
        Effect.fail(new InternalError({ message: "Not implemented" })),
      uploadPart: (_key, _uploadId, _partNumber, _body) =>
        Effect.fail(new InternalError({ message: "Not implemented" })),
      completeMultipartUpload: (_key, _uploadId, _parts) =>
        Effect.fail(new InternalError({ message: "Not implemented" })),
      abortMultipartUpload: (_key, _uploadId) =>
        Effect.fail(new InternalError({ message: "Not implemented" })),
      listMultipartUploads: (_args) =>
        Effect.fail(new InternalError({ message: "Not implemented" })),
      listParts: (_key, _uploadId) =>
        Effect.fail(new InternalError({ message: "Not implemented" })),
    };
  });
