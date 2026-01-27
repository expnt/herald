import { HttpClientRequest, type HttpClientResponse } from "@effect/platform";
import { type Chunk, Effect, Stream } from "effect";
import type {
  BackendError,
  CommonPrefix,
  DeleteObjectsResult,
  HeadObjectResult,
  ListObjectsResult,
  ObjectAttributes,
  ObjectInfo,
  ObjectResponse,
  PutObjectResult,
} from "../../Services/Backend.ts";
import {
  BadDigest,
  InternalError,
  InvalidRequest,
} from "../../Services/Backend.ts";
import { normalizeHeaders } from "../../Services/S3HeaderService.ts";
import { mapError, type SwiftTarget } from "./Utils.ts";

export interface SwiftObject {
  readonly name?: string;
  readonly hash?: string;
  readonly bytes?: number;
  readonly content_type?: string;
  readonly last_modified?: string;
  readonly subdir?: string;
}

export const makeObjectOps = (
  {
    container,
    storageUrl: _,
    token,
    url,
    client,
    headerService,
    checksumService,
  }: SwiftTarget,
) => {
  const listObjects = (args: {
    prefix?: string;
    delimiter?: string;
    marker?: string;
    maxKeys?: number;
    encodingType?: string;
    continuationToken?: string;
    startAfter?: string;
    listType?: 1 | 2;
  }): Effect.Effect<ListObjectsResult, BackendError> =>
    Effect.gen(function* () {
      const limit = args.maxKeys ?? 1000;
      const query = new URLSearchParams({ format: "json" });
      if (args.prefix) query.set("prefix", args.prefix);
      if (args.delimiter) query.set("delimiter", args.delimiter);
      if (args.marker) query.set("marker", args.marker);
      query.set("limit", String(limit + 1));
      if (args.continuationToken) query.set("marker", args.continuationToken);
      if (args.startAfter) query.set("marker", args.startAfter);

      const response: HttpClientResponse.HttpClientResponse = yield* client
        .execute(
          HttpClientRequest.get(`${url}?${query.toString()}`).pipe(
            HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
          ),
        ).pipe(
          Effect.mapError((e) => mapError(500, String(e), container)),
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
          mapError(500, `Failed to parse Swift response: ${e}`, container)
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
  const headObject = (
    key: string,
    headers: Record<string, string | string[] | undefined>,
  ): Effect.Effect<HeadObjectResult, BackendError> =>
    Effect.gen(function* () {
      const encodedKey = key.split("/").map(encodeURIComponent).join("/");
      const swiftHeaders: Record<string, string> = {
        "X-Auth-Token": token,
      };
      const response: HttpClientResponse.HttpClientResponse = yield* client
        .execute(
          HttpClientRequest.head(`${url}/${encodedKey}`).pipe(
            HttpClientRequest.setHeaders(swiftHeaders),
          ),
        ).pipe(
          Effect.mapError((e) => mapError(500, String(e), container)),
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

      const { metadata, s3Headers, checksums, partsCount } = headerService
        .fromSwiftHeaders(response.headers);

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

      const { s3Params } = headerService.fromRequestHeaders(headers);
      const checksumMode = s3Params.checksumMode === "ENABLED";

      if (checksumMode) {
        Object.assign(
          s3Headers,
          headerService.toResponseHeaders({
            checksumAlgorithm: checksums.algorithm,
            checksumCRC32: checksums.crc32,
            checksumCRC32C: checksums.crc32c,
            checksumCRC64NVME: checksums.crc64nvme,
            checksumSHA1: checksums.sha1,
            checksumSHA256: checksums.sha256,
            checksumType: checksums.type,
            metadata: {},
            headers: {},
            partsCount,
          }),
        );
      }

      return {
        contentType: (Array.isArray(response.headers["content-type"])
          ? response.headers["content-type"][0]
          : response.headers["content-type"]) || undefined,
        contentLength,
        etag: etag || undefined,
        lastModified: lastModified ? new Date(lastModified) : undefined,
        metadata,
        headers: s3Headers,
        checksumAlgorithm: checksums.algorithm,
        checksumCRC32: checksums.crc32,
        checksumCRC32C: checksums.crc32c,
        checksumCRC64NVME: checksums.crc64nvme,
        checksumSHA1: checksums.sha1,
        checksumSHA256: checksums.sha256,
        checksumType: checksums.type,
        partsCount,
      } satisfies HeadObjectResult;
    });

  return {
    listObjects,

    listVersions: (args: {
      prefix?: string;
      delimiter?: string;
      keyMarker?: string;
      versionIdMarker?: string;
      maxKeys?: number;
      encodingType?: string;
    }) =>
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
        const encodedKey = key.split("/").map(encodeURIComponent).join("/");
        const swiftHeaders: Record<string, string> = {
          "X-Auth-Token": token,
        };
        const { s3Params } = headerService.fromRequestHeaders(headers);

        if (headers["range"] || headers["Range"]) {
          swiftHeaders["Range"] = String(headers["range"] || headers["Range"]);
        }
        if (headers["if-match"] || headers["If-Match"]) {
          swiftHeaders["If-Match"] = String(
            headers["if-match"] || headers["If-Match"],
          );
        }
        if (headers["if-none-match"] || headers["If-None-Match"]) {
          swiftHeaders["If-None-Match"] = String(
            headers["if-none-match"] || headers["If-None-Match"],
          );
        }
        if (headers["if-modified-since"] || headers["If-Modified-Since"]) {
          swiftHeaders["If-Modified-Since"] = String(
            headers["if-modified-since"] || headers["If-Modified-Since"],
          );
        }
        if (headers["if-unmodified-since"] || headers["If-Unmodified-Since"]) {
          swiftHeaders["If-Unmodified-Since"] = String(
            headers["if-unmodified-since"] || headers["If-Unmodified-Since"],
          );
        }

        const response: HttpClientResponse.HttpClientResponse = yield* client
          .execute(
            HttpClientRequest.get(`${url}/${encodedKey}`).pipe(
              HttpClientRequest.setHeaders(swiftHeaders),
            ),
          ).pipe(
            Effect.mapError((e) => mapError(500, String(e), container)),
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

        const { metadata, s3Headers, checksums, partsCount } = headerService
          .fromSwiftHeaders(response.headers);

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

        const checksumMode = s3Params.checksumMode === "ENABLED";

        if (checksumMode) {
          Object.assign(
            s3Headers,
            headerService.toResponseHeaders({
              checksumAlgorithm: checksums.algorithm,
              checksumCRC32: checksums.crc32,
              checksumCRC32C: checksums.crc32c,
              checksumCRC64NVME: checksums.crc64nvme,
              checksumSHA1: checksums.sha1,
              checksumSHA256: checksums.sha256,
              checksumType: checksums.type,
              metadata: {},
              headers: {},
              partsCount,
            }),
          );
        }

        // Try to get the native stream to avoid Effect <-> WebStream conversion overhead
        const nativeStream =
          (response as unknown as { source?: unknown }).source instanceof
              Response
            ? (response as unknown as { source: Response }).source.body
            : undefined;

        return {
          stream: response.stream,
          nativeStream: nativeStream || undefined,
          contentType: (Array.isArray(response.headers["content-type"])
            ? response.headers["content-type"][0]
            : response.headers["content-type"]) || undefined,
          contentLength,
          etag: etag || undefined,
          lastModified: lastModified ? new Date(lastModified) : undefined,
          metadata,
          headers: s3Headers,
          checksumAlgorithm: checksums.algorithm,
          checksumCRC32: checksums.crc32,
          checksumCRC32C: checksums.crc32c,
          checksumCRC64NVME: checksums.crc64nvme,
          checksumSHA1: checksums.sha1,
          checksumSHA256: checksums.sha256,
          checksumType: checksums.type,
          partsCount,
        } satisfies ObjectResponse;
      }),

    headObject,

    putObject: (
      key: string,
      stream: Stream.Stream<Uint8Array, Error>,
      headers: Record<string, string | string[] | undefined>,
    ) => {
      const encodedKey = key.split("/").map(encodeURIComponent).join("/");

      return Effect.gen(function* () {
        const { checksums, metadata } = headerService.fromRequestHeaders(
          headers,
        );
        const normalized = normalizeHeaders(headers);

        const swiftHeaders: Record<string, string> = {
          "X-Auth-Token": token,
          "Content-Type": (normalized["content-type"] ||
            "application/octet-stream") as string,
          ...headerService.toSwiftHeaders(metadata, checksums),
        };

        const contentLength = normalized["content-length"]
          ? parseInt(normalized["content-length"])
          : undefined;
        if (contentLength) {
          swiftHeaders["Content-Length"] = String(contentLength);
        }

        const validatedStream = (yield* checksumService.validate(
          stream,
          checksums,
        )).pipe(
          Stream.catchAll((e) => {
            // Preserve BadDigest and InvalidRequest errors from checksum validation
            if (e instanceof BadDigest || e instanceof InvalidRequest) {
              return Stream.fail(e as BackendError);
            }
            return Stream.fail(
              new InternalError({
                message: `error on checksum stream: ${String(e)}`,
              }),
            );
          }),
        );

        // Align with S3: buffer small files (< 1MB) and validate before HTTP request
        const bodyStream = (false as boolean) // (contentLength !== undefined && contentLength < 1024 * 1024)
          ? yield* Effect.gen(function* () {
            // Buffer small files: consume stream to trigger validation BEFORE HTTP request
            const chunks: Chunk.Chunk<Uint8Array> = yield* Stream.runCollect(
              validatedStream,
            ).pipe(
              Effect.mapError((e) => {
                // Preserve BadDigest and InvalidRequest errors
                if (e instanceof BadDigest || e instanceof InvalidRequest) {
                  return e;
                }
                return new InternalError({ message: String(e) });
              }),
            );
            // Recreate stream from chunks for HTTP request
            return Stream.fromIterable(chunks);
          })
          : validatedStream;

        const request = HttpClientRequest.put(`${url}/${encodedKey}`).pipe(
          HttpClientRequest.setHeaders(swiftHeaders),
          HttpClientRequest.bodyStream(bodyStream),
        );

        const response: HttpClientResponse.HttpClientResponse = yield* client
          .execute(request).pipe(
            Effect.catchAll(
              (
                e,
              ): Effect.Effect<
                HttpClientResponse.HttpClientResponse,
                BackendError
              > => {
                // Check for BadDigest in the error message or cause
                const errorStr = String(e);
                if (
                  errorStr.includes("BadDigest") ||
                  errorStr.includes("checksum mismatch") ||
                  errorStr.includes("Checksum mismatch")
                ) {
                  return Effect.fail(new BadDigest({ message: errorStr }));
                }
                if (e && typeof e === "object" && "cause" in e) {
                  const cause = (e as { cause?: unknown }).cause;
                  if (
                    cause instanceof BadDigest ||
                    cause instanceof InvalidRequest
                  ) {
                    return Effect.fail(cause);
                  }
                  const causeStr = String(cause);
                  if (
                    causeStr.includes("BadDigest") ||
                    causeStr.includes("checksum mismatch") ||
                    causeStr.includes("Checksum mismatch")
                  ) {
                    return Effect.fail(new BadDigest({ message: causeStr }));
                  }
                }
                return Effect.fail(mapError(500, errorStr, container));
              },
            ),
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
          checksumAlgorithm: checksums.algorithm,
          checksumCRC32: checksums.crc32,
          checksumCRC32C: checksums.crc32c,
          checksumCRC64NVME: checksums.crc64nvme,
          checksumSHA1: checksums.sha1,
          checksumSHA256: checksums.sha256,
        } satisfies PutObjectResult;
      });
    },

    deleteObject: (key: string) =>
      Effect.gen(function* () {
        const encodedKey = key.split("/").map(encodeURIComponent).join("/");

        // Try SLO delete first (recursive)
        const response: HttpClientResponse.HttpClientResponse = yield* client
          .execute(
            HttpClientRequest.del(`${url}/${encodedKey}`).pipe(
              HttpClientRequest.setHeaders({
                "X-Auth-Token": token,
                "X-Static-Large-Object": "true",
              }),
              HttpClientRequest.setUrlParams({
                "multipart-manifest": "delete",
              }),
            ),
          ).pipe(
            Effect.mapError((e) => mapError(500, String(e), container)),
          );

        const responseBody = yield* response.text.pipe(
          Effect.orElseSucceed(() => ""),
        );

        if (
          response.status === 400 ||
          (response.status === 200 && responseBody.includes("Not an SLO"))
        ) {
          // Not an SLO, try regular delete
          const regResponse: HttpClientResponse.HttpClientResponse =
            yield* client.execute(
              HttpClientRequest.del(`${url}/${encodedKey}`).pipe(
                HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
              ),
            ).pipe(
              Effect.mapError((e) => mapError(500, String(e), container)),
            );

          if (regResponse.status < 200 || regResponse.status >= 300) {
            if (regResponse.status === 404) return;
            const message = yield* regResponse.text.pipe(
              Effect.orElseSucceed(() => "Error"),
            );
            return yield* Effect.fail(
              mapError(regResponse.status, message, container, "DELETE", key),
            );
          }
          return;
        }

        if (response.status < 200 || response.status >= 300) {
          if (response.status === 404) {
            return;
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
      }),

    deleteObjects: (
      objects: readonly { key: string; versionId?: string }[],
    ) =>
      Effect.gen(function* () {
        const results = yield* Effect.all(
          objects.map((obj) =>
            Effect.gen(function* () {
              const encodedKey = obj.key.split("/").map(encodeURIComponent)
                .join(
                  "/",
                );
              let response: HttpClientResponse.HttpClientResponse =
                yield* client.execute(
                  HttpClientRequest.del(`${url}/${encodedKey}`).pipe(
                    HttpClientRequest.setHeaders({
                      "X-Auth-Token": token,
                      "X-Static-Large-Object": "true",
                    }),
                    HttpClientRequest.setUrlParams({
                      "multipart-manifest": "delete",
                    }),
                  ),
                ).pipe(
                  Effect.mapError((e) => mapError(500, String(e), container)),
                );

              const responseBody = yield* response.text.pipe(
                Effect.orElseSucceed(() => ""),
              );

              if (
                response.status === 400 ||
                (response.status === 200 && responseBody.includes("Not an SLO"))
              ) {
                // Not an SLO, try regular delete
                response = yield* client.execute(
                  HttpClientRequest.del(`${url}/${encodedKey}`).pipe(
                    HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
                  ),
                ).pipe(
                  Effect.mapError((e) => mapError(500, String(e), container)),
                );
              }

              if (
                (response.status >= 200 && response.status < 300) ||
                response.status === 204 || response.status === 404
              ) {
                return { key: obj.key, error: null };
              } else {
                const errorBody = yield* response.text.pipe(
                  Effect.orElseSucceed(() => "Unknown error"),
                );
                return {
                  key: obj.key,
                  error: {
                    code: String(response.status),
                    message: errorBody,
                  },
                };
              }
            })
          ),
          { concurrency: 10 },
        );

        const deleted: string[] = [];
        const errors: { key: string; code: string; message: string }[] = [];

        for (const res of results) {
          if (res.error) {
            errors.push({ key: res.key, ...res.error });
          } else {
            deleted.push(res.key);
          }
        }

        return { deleted, errors } satisfies DeleteObjectsResult;
      }),

    getObjectAttributes: (
      key: string,
      attributes: readonly string[],
      headers: Record<string, string | string[] | undefined>,
    ) =>
      Effect.gen(function* () {
        const head = yield* headObject(
          key,
          { "x-amz-checksum-mode": "ENABLED", ...headers },
        );

        const lowerAttrs = attributes.map((a) => a.toLowerCase());
        const isSLO =
          head.headers["x-static-large-object"]?.toLowerCase() === "true";
        const result: ObjectAttributes = {
          ...(lowerAttrs.includes("etag") ? { etag: head.etag } : {}),
          ...(lowerAttrs.includes("checksum")
            ? {
              checksum: {
                checksumCRC32: head.checksumCRC32,
                checksumCRC32C: head.checksumCRC32C,
                checksumCRC64NVME: head.checksumCRC64NVME,
                checksumSHA1: head.checksumSHA1,
                checksumSHA256: head.checksumSHA256,
                checksumType: head.checksumAlgorithm
                  ? (isSLO ? "COMPOSITE" : "FULL_OBJECT")
                  : undefined,
              },
            }
            : {}),
          ...(lowerAttrs.includes("objectsize")
            ? { objectSize: head.contentLength }
            : {}),
          ...(lowerAttrs.includes("storageclass")
            ? { storageClass: "STANDARD" }
            : {}),
          ...(lowerAttrs.includes("objectparts")
            ? {
              objectParts: {
                totalPartsCount: 0, // Placeholder
                partNumberMarker: 0,
                nextPartNumberMarker: 0,
                maxParts: 1000,
                isTruncated: false,
                parts: [],
              },
            }
            : {}),
        };

        return result;
      }),
  };
};
