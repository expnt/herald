import { Effect, Option, Schedule, type Stream } from "effect";
import { type HttpClient, HttpClientRequest } from "@effect/platform";
import {
  type BackendError,
  type CommonPrefix,
  type CompleteMultipartUploadResult,
  type DeleteObjectsResult,
  type HeadObjectResult,
  InternalError,
  InvalidPart,
  type ListMultipartUploadsResult,
  type ListObjectsResult,
  type ListPartsResult,
  type MultipartUploadInfo,
  type MultipartUploadResult,
  NoSuchUpload,
  type ObjectAttributes,
  type ObjectInfo,
  type ObjectResponse,
  type PartInfo,
  type PutObjectResult,
  type UploadPartResult,
} from "../../Services/Backend.ts";
import {
  mapError,
  MP_META_PREFIX,
  MP_SEGMENTS_PREFIX,
  type SwiftTarget,
} from "./Utils.ts";
import { fixHeaderEncoding } from "../../Frontend/Utils.ts";

export interface SwiftObject {
  readonly name?: string;
  readonly hash?: string;
  readonly bytes?: number;
  readonly content_type?: string;
  readonly last_modified?: string;
  readonly subdir?: string;
}

interface SwiftChecksumFields {
  readonly checksumAlgorithm?: string;
  readonly checksumCRC32?: string;
  readonly checksumCRC32C?: string;
  readonly checksumCRC64NVME?: string;
  readonly checksumSHA1?: string;
  readonly checksumSHA256?: string;
}

const extractChecksumsFromS3Headers = (
  headers: Record<string, string | string[] | undefined>,
): SwiftChecksumFields => ({
  checksumAlgorithm: (headers["x-amz-checksum-algorithm"] ||
    headers["x-amz-sdk-checksum-algorithm"]) as string,
  checksumCRC32: headers["x-amz-checksum-crc32"] as string,
  checksumCRC32C: headers["x-amz-checksum-crc32c"] as string,
  checksumCRC64NVME: headers["x-amz-checksum-crc64nvme"] as string,
  checksumSHA1: headers["x-amz-checksum-sha1"] as string,
  checksumSHA256: headers["x-amz-checksum-sha256"] as string,
});

const mapChecksumsToSwiftMetadata = (
  checksums: SwiftChecksumFields,
  swiftHeaders: Record<string, string>,
) => {
  if (checksums.checksumAlgorithm) {
    swiftHeaders["X-Object-Meta-S3-Checksum-Algorithm"] =
      checksums.checksumAlgorithm;
  }
  if (checksums.checksumCRC32) {
    swiftHeaders["X-Object-Meta-S3-Checksum-CRC32"] = checksums.checksumCRC32;
  }
  if (checksums.checksumCRC32C) {
    swiftHeaders["X-Object-Meta-S3-Checksum-CRC32C"] = checksums.checksumCRC32C;
  }
  if (checksums.checksumCRC64NVME) {
    swiftHeaders["X-Object-Meta-S3-Checksum-CRC64NVME"] =
      checksums.checksumCRC64NVME;
  }
  if (checksums.checksumSHA1) {
    swiftHeaders["X-Object-Meta-S3-Checksum-SHA1"] = checksums.checksumSHA1;
  }
  if (checksums.checksumSHA256) {
    swiftHeaders["X-Object-Meta-S3-Checksum-SHA256"] = checksums.checksumSHA256;
  }
};

const extractChecksumsFromSwiftHeaders = (
  swiftHeaders: Record<string, string | string[] | undefined>,
): SwiftChecksumFields => {
  const get = (key: string) => {
    const val = swiftHeaders[key.toLowerCase()];
    return Array.isArray(val) ? val[0] : val;
  };
  return {
    checksumAlgorithm: get("x-object-meta-s3-checksum-algorithm"),
    checksumCRC32: get("x-object-meta-s3-checksum-crc32"),
    checksumCRC32C: get("x-object-meta-s3-checksum-crc32c"),
    checksumCRC64NVME: get("x-object-meta-s3-checksum-crc64nvme"),
    checksumSHA1: get("x-object-meta-s3-checksum-sha1"),
    checksumSHA256: get("x-object-meta-s3-checksum-sha256"),
  };
};

const mapChecksumsToS3Headers = (
  checksums: SwiftChecksumFields,
  s3Headers: Record<string, string>,
) => {
  if (checksums.checksumAlgorithm) {
    s3Headers["x-amz-checksum-algorithm"] = checksums.checksumAlgorithm;
  }
  if (checksums.checksumCRC32) {
    s3Headers["x-amz-checksum-crc32"] = checksums.checksumCRC32;
  }
  if (checksums.checksumCRC32C) {
    s3Headers["x-amz-checksum-crc32c"] = checksums.checksumCRC32C;
  }
  if (checksums.checksumCRC64NVME) {
    s3Headers["x-amz-checksum-crc64nvme"] = checksums.checksumCRC64NVME;
  }
  if (checksums.checksumSHA1) {
    s3Headers["x-amz-checksum-sha1"] = checksums.checksumSHA1;
  }
  if (checksums.checksumSHA256) {
    s3Headers["x-amz-checksum-sha256"] = checksums.checksumSHA256;
  }
};

export const makeObjectOps = (
  target: SwiftTarget,
  client: HttpClient.HttpClient,
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
  }) =>
    Effect.gen(function* () {
      const { url, token, container } = target;
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

  return {
    listObjects: (args: {
      prefix?: string;
      delimiter?: string;
      marker?: string;
      maxKeys?: number;
      encodingType?: string;
      continuationToken?: string;
      startAfter?: string;
      listType?: 1 | 2;
    }) => listObjects(args),

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
        const { url, token, container } = target;
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

        const checksumMode = (headers["x-amz-checksum-mode"] ||
          headers["X-Amz-Checksum-Mode"]) === "ENABLED";

        const checksums = extractChecksumsFromSwiftHeaders(response.headers);

        if (checksumMode) {
          mapChecksumsToS3Headers(checksums, s3Headers);
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
          ...checksums,
        } satisfies ObjectResponse;
      }),

    headObject: (
      key: string,
      _headers: Record<string, string | string[] | undefined>,
    ) =>
      Effect.gen(function* () {
        const { url, token, container } = target;
        const encodedKey = key.split("/").map(encodeURIComponent).join("/");
        const swiftHeaders: Record<string, string> = {
          "X-Auth-Token": token,
        };
        const response = yield* client.execute(
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

        const checksumMode = (_headers["x-amz-checksum-mode"] ||
          _headers["X-Amz-Checksum-Mode"]) === "ENABLED";

        const checksums = extractChecksumsFromSwiftHeaders(response.headers);

        if (checksumMode) {
          mapChecksumsToS3Headers(checksums, s3Headers);
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
          ...checksums,
        } satisfies HeadObjectResult;
      }),

    putObject: (
      key: string,
      stream: Stream.Stream<Uint8Array, Error>,
      headers: Record<string, string | string[] | undefined>,
    ): Effect.Effect<PutObjectResult, BackendError> => {
      const { url, token, container } = target;
      const encodedKey = key.split("/").map(encodeURIComponent).join("/");

      return Effect.gen(function* () {
        const swiftHeaders: Record<string, string> = {
          "X-Auth-Token": token,
          "Content-Type": (headers["content-type"] || headers["Content-Type"] ||
            "application/octet-stream") as string,
        };

        const contentLength = headers["content-length"] ||
          headers["Content-Length"];
        if (contentLength) {
          swiftHeaders["Content-Length"] = String(contentLength);
        }

        for (const [k, v] of Object.entries(headers)) {
          const lowK = k.toLowerCase();
          if (lowK.startsWith("x-amz-meta-")) {
            const metaKey = lowK.substring("x-amz-meta-".length);
            const value = fixHeaderEncoding(String(v));
            swiftHeaders[`X-Object-Meta-${metaKey}`] =
              /[^\x20-\x7E]/.test(value) ? encodeURIComponent(value) : value;
          }
        }

        const checksums = extractChecksumsFromS3Headers(headers);
        mapChecksumsToSwiftMetadata(checksums, swiftHeaders);

        const request = HttpClientRequest.put(`${url}/${encodedKey}`).pipe(
          HttpClientRequest.setHeaders(swiftHeaders),
          HttpClientRequest.bodyStream(stream),
        );

        const response = yield* client.execute(request).pipe(
          Effect.mapError((e) => {
            return mapError(500, String(e), container);
          }),
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
          ...checksums,
        } satisfies PutObjectResult;
      });
    },

    deleteObject: (key: string) =>
      Effect.gen(function* () {
        const { url, token, container } = target;
        const encodedKey = key.split("/").map(encodeURIComponent).join("/");

        // Try SLO delete first (recursive)
        const response = yield* client.execute(
          HttpClientRequest.del(`${url}/${encodedKey}`).pipe(
            HttpClientRequest.setHeaders({
              "X-Auth-Token": token,
              "X-Static-Large-Object": "true",
            }),
            HttpClientRequest.setUrlParams({ "multipart-manifest": "delete" }),
          ),
        ).pipe(
          Effect.mapError((e) => mapError(500, String(e), container)),
        );

        if (response.status === 400) {
          // Not an SLO, try regular delete
          const regResponse = yield* client.execute(
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

    deleteObjects: (objects: readonly { key: string; versionId?: string }[]) =>
      Effect.gen(function* () {
        const { url, token, container } = target;

        const results = yield* Effect.all(
          objects.map((obj) =>
            Effect.gen(function* () {
              const encodedKey = obj.key.split("/").map(encodeURIComponent)
                .join(
                  "/",
                );
              let response = yield* client.execute(
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

              if (response.status === 400) {
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
        const head = yield* makeObjectOps(target, client).headObject(
          key,
          { "x-amz-checksum-mode": "ENABLED", ...headers },
        );

        const lowerAttrs = attributes.map((a) => a.toLowerCase());
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
                checksumType: head.checksumAlgorithm,
              },
            }
            : {}),
          ...(lowerAttrs.includes("objectsize")
            ? { objectSize: head.contentLength }
            : {}),
          ...(lowerAttrs.includes("storageclass")
            ? { storageClass: "STANDARD" }
            : {}),
        };

        // ObjectParts is harder to implement for finished SLOs without fetching the manifest
        // For now we omit it or return empty if not easily available

        return result;
      }),

    createMultipartUpload: (
      _key: string,
      headers: Record<string, string | string[] | undefined>,
    ): Effect.Effect<MultipartUploadResult, BackendError> =>
      Effect.gen(function* () {
        const uploadId = yield* Effect.try({
          try: () => crypto.randomUUID(),
          catch: (e) => new InternalError({ message: String(e) }),
        });
        const checksums = extractChecksumsFromS3Headers(headers);
        return {
          uploadId,
          checksumAlgorithm: checksums.checksumAlgorithm,
        } satisfies MultipartUploadResult;
      }),

    uploadPart: (
      _key: string,
      uploadId: string,
      partNumber: number,
      body: Stream.Stream<Uint8Array, Error>,
      headers: Record<string, string | string[] | undefined>,
    ): Effect.Effect<UploadPartResult, BackendError> =>
      Effect.gen(function* () {
        const { url, token, container } = target;
        const segmentKey = `${MP_SEGMENTS_PREFIX}${uploadId}/${partNumber}`;
        const encodedSegmentKey = segmentKey.split("/").map(encodeURIComponent)
          .join("/");

        const swiftHeaders: Record<string, string> = {
          "X-Auth-Token": token,
        };

        const checksums = extractChecksumsFromS3Headers(headers);
        mapChecksumsToSwiftMetadata(checksums, swiftHeaders);

        const response = yield* client.execute(
          HttpClientRequest.put(`${url}/${encodedSegmentKey}`).pipe(
            HttpClientRequest.setHeaders(swiftHeaders),
            HttpClientRequest.bodyStream(body),
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
              "PUT",
              segmentKey,
            ),
          );
        }

        const etagHeader = response.headers["etag"];
        const etagValue = Array.isArray(etagHeader)
          ? etagHeader[0]
          : etagHeader;

        return {
          etag: etagValue || "",
          ...checksums,
        } satisfies UploadPartResult;
      }),

    completeMultipartUpload: (
      key: string,
      uploadId: string,
      parts: readonly {
        etag: string;
        partNumber: number;
        checksumCRC32?: string;
        checksumCRC32C?: string;
        checksumCRC64NVME?: string;
        checksumSHA1?: string;
        checksumSHA256?: string;
      }[],
      metadata: Record<string, string>,
      headers: Record<string, string | string[] | undefined>,
    ): Effect.Effect<CompleteMultipartUploadResult, BackendError> =>
      Effect.gen(function* () {
        if (parts.length === 0) {
          return yield* Effect.fail(
            new InvalidPart({
              message: "At least one part must be specified.",
            }),
          );
        }
        const { url, token, container } = target;
        const encodedKey = key.split("/").map(encodeURIComponent).join("/");

        // Fetch segment info to get sizes
        const segmentMap = new Map<string, ObjectInfo>();
        const buildSegmentMap = Effect.gen(function* () {
          segmentMap.clear();
          let segmentMarker: string | undefined = undefined;
          while (true) {
            const segmentsResult: ListObjectsResult = yield* listObjects({
              prefix: `${MP_SEGMENTS_PREFIX}${uploadId}/`,
              marker: segmentMarker,
            });
            for (const c of segmentsResult.contents) {
              segmentMap.set(c.key, c);
            }
            if (!segmentsResult.isTruncated || !segmentsResult.nextMarker) {
              break;
            }
            segmentMarker = segmentsResult.nextMarker;
          }

          // Verify all parts are present
          for (const p of parts) {
            const segmentKey =
              `${MP_SEGMENTS_PREFIX}${uploadId}/${p.partNumber}`;
            if (!segmentMap.has(segmentKey)) {
              return yield* Effect.fail(
                new NoSuchUpload({
                  uploadId,
                  message: `Part ${p.partNumber} not found in segment listing`,
                }),
              );
            }
          }
        });

        // Retry with exponential backoff for eventual consistency
        yield* buildSegmentMap.pipe(
          Effect.retry({
            while: (e) => e instanceof NoSuchUpload,
            schedule: Schedule.exponential("100 millis").pipe(
              Schedule.compose(Schedule.recurs(4)),
            ),
          }),
        );

        // 1. Build SLO manifest
        const manifest = [];
        for (const p of parts) {
          const segmentKey = `${MP_SEGMENTS_PREFIX}${uploadId}/${p.partNumber}`;
          const info = segmentMap.get(segmentKey)!;
          manifest.push({
            path: `/${container}/${segmentKey}`,
            etag: p.etag.replace(/"/g, ""),
            size_bytes: info.size,
          });
        }

        // 2. PUT SLO manifest
        const swiftHeaders: Record<string, string> = {
          "X-Auth-Token": token,
          "Content-Type": (metadata["content-type"] ||
            "application/octet-stream") as string,
        };

        for (const [k, v] of Object.entries(metadata)) {
          const lowK = k.toLowerCase();
          if (lowK.startsWith("x-amz-meta-")) {
            const metaKey = lowK.substring("x-amz-meta-".length);
            const value = fixHeaderEncoding(String(v));
            swiftHeaders[`X-Object-Meta-${metaKey}`] =
              /[^\x20-\x7E]/.test(value) ? encodeURIComponent(value) : value;
          }
        }

        const checksums = extractChecksumsFromS3Headers(headers);
        mapChecksumsToSwiftMetadata(checksums, swiftHeaders);

        const body = new TextEncoder().encode(JSON.stringify(manifest));

        const request = HttpClientRequest.put(`${url}/${encodedKey}`).pipe(
          HttpClientRequest.setUrlParams({ "multipart-manifest": "put" }),
          HttpClientRequest.bodyUint8Array(body),
          HttpClientRequest.setHeaders({
            ...swiftHeaders,
            "X-Static-Large-Object": "true",
            "Content-Length": String(body.length),
          }),
        );

        const response = yield* client.execute(request).pipe(
          Effect.mapError((e) => {
            return mapError(500, String(e), container);
          }),
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

        // 3. Delete the metadata object
        const metaKey = `${MP_META_PREFIX}${key}/${uploadId}`;
        const encodedMetaKey = metaKey.split("/").map(encodeURIComponent).join(
          "/",
        );
        yield* client.execute(
          HttpClientRequest.del(`${url}/${encodedMetaKey}`).pipe(
            HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
          ),
        ).pipe(Effect.ignore);

        return {
          location: `${url}/${encodedKey}`,
          bucket: container,
          key,
          etag: etagValue || "",
          ...checksums,
        } satisfies CompleteMultipartUploadResult;
      }),

    abortMultipartUpload: (
      key: string,
      uploadId: string,
    ): Effect.Effect<void, BackendError> =>
      Effect.gen(function* () {
        const { url, token } = target;

        // 1. Delete the segments
        let marker: string | undefined = undefined;
        while (true) {
          const segmentsResult: ListObjectsResult = yield* listObjects({
            prefix: `${MP_SEGMENTS_PREFIX}${uploadId}/`,
            marker,
          });

          yield* Effect.all(
            segmentsResult.contents.map((content) => {
              const encodedKey = content.key.split("/").map(encodeURIComponent)
                .join("/");
              return client.execute(
                HttpClientRequest.del(`${url}/${encodedKey}`).pipe(
                  HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
                ),
              ).pipe(Effect.ignore);
            }),
            { concurrency: 10 },
          );

          if (!segmentsResult.isTruncated || !segmentsResult.nextMarker) {
            break;
          }
          marker = segmentsResult.nextMarker;
        }

        // 2. Delete the metadata object
        const metaKey = `${MP_META_PREFIX}${key}/${uploadId}`;
        const encodedMetaKey = metaKey.split("/").map(encodeURIComponent).join(
          "/",
        );
        yield* client.execute(
          HttpClientRequest.del(`${url}/${encodedMetaKey}`).pipe(
            HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
          ),
        ).pipe(Effect.ignore);
      }),

    listMultipartUploads: (args: {
      prefix?: string;
      delimiter?: string;
      keyMarker?: string;
      uploadIdMarker?: string;
      maxUploads?: number;
      encodingType?: string;
    }): Effect.Effect<ListMultipartUploadsResult, BackendError> =>
      Effect.gen(function* () {
        const { container } = target;
        const prefix = `${MP_META_PREFIX}${args.prefix ?? ""}`;
        const marker = args.keyMarker
          ? `${MP_META_PREFIX}${args.keyMarker}/${args.uploadIdMarker ?? ""}`
          : undefined;

        const metaResult = yield* listObjects({
          prefix,
          delimiter: args.delimiter,
          maxKeys: args.maxUploads,
          marker,
        });

        const uploads: MultipartUploadInfo[] = metaResult.contents.map((c) => {
          const parts = c.key.substring(MP_META_PREFIX.length).split("/");
          const uploadId = parts.pop()!;
          const key = parts.join("/");
          return {
            key,
            uploadId,
            owner: { id: "swift", displayName: "Swift User" },
            initiator: { id: "swift", displayName: "Swift User" },
            storageClass: "STANDARD",
            initiated: c.lastModified!,
          };
        });

        return {
          bucket: container,
          prefix: args.prefix,
          keyMarker: args.keyMarker,
          uploadIdMarker: args.uploadIdMarker,
          maxUploads: args.maxUploads ?? 1000,
          delimiter: args.delimiter,
          isTruncated: metaResult.isTruncated,
          uploads,
          commonPrefixes: metaResult.commonPrefixes.map((cp) => ({
            prefix: cp.prefix.substring(MP_META_PREFIX.length),
          })),
          encodingType: args.encodingType,
        } satisfies ListMultipartUploadsResult;
      }),

    listParts: (
      key: string,
      uploadId: string,
    ): Effect.Effect<ListPartsResult, BackendError> =>
      Effect.gen(function* () {
        const { url, token, container } = target;

        // Check if upload exists by checking for metadata object
        const metaKey = `${MP_META_PREFIX}${key}/${uploadId}`;
        const encodedMetaKey = metaKey.split("/").map(encodeURIComponent).join(
          "/",
        );
        const metaResponse = yield* client.execute(
          HttpClientRequest.head(`${url}/${encodedMetaKey}`).pipe(
            HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
          ),
        ).pipe(
          Effect.mapError((e) => mapError(500, String(e), container)),
        );

        if (metaResponse.status === 404) {
          return yield* Effect.fail(
            new NoSuchUpload({
              uploadId,
              message:
                `The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.`,
            }),
          );
        }

        const segmentsResult = yield* listObjects({
          prefix: `${MP_SEGMENTS_PREFIX}${uploadId}/`,
        });

        const parts: PartInfo[] = segmentsResult.contents.map((c) => {
          const partNumber = parseInt(c.key.split("/").pop() || "0");
          return {
            partNumber,
            lastModified: c.lastModified,
            etag: c.etag,
            size: c.size,
          };
        });

        return {
          bucket: container,
          key,
          uploadId,
          owner: { id: "swift", displayName: "Swift User" },
          initiator: { id: "swift", displayName: "Swift User" },
          storageClass: "STANDARD",
          partNumberMarker: 0,
          nextPartNumberMarker: 0,
          maxParts: 1000,
          isTruncated: false,
          parts,
        } satisfies ListPartsResult;
      }),
  };
};
