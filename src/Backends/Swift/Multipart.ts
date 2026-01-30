import { HttpClientRequest, type HttpClientResponse } from "@effect/platform";
import { Effect, Option, Schedule, Stream } from "effect";
import {
  type BackendError,
  type CompleteMultipartUploadResult,
  type HeadObjectResult,
  InternalError,
  InvalidPart,
  type ListMultipartUploadsResult,
  type ListObjectsResult,
  type ListPartsResult,
  type MultipartUploadInfo,
  type MultipartUploadResult,
  NoSuchUpload,
  type ObjectInfo,
  type PartInfo,
  type UploadPartResult,
} from "../../Services/Backend.ts";
import {
  encodeObjectKeyForSwift,
  formatSwiftTransportError,
  mapError,
  MP_META_PREFIX,
  MP_SEGMENTS_PREFIX,
  type SwiftTarget,
} from "./Utils.ts";
import type { KeyValueStore } from "@effect/platform";

export const makeMultipartOps = (
  target: SwiftTarget,
  multipartMetadataStore: KeyValueStore.KeyValueStore,
  objectOps: {
    listObjects: (args: {
      prefix?: string;
      delimiter?: string;
      marker?: string;
      maxKeys?: number;
    }) => Effect.Effect<ListObjectsResult, BackendError>;
    headObject: (
      key: string,
      headers: Record<string, string | string[] | undefined>,
    ) => Effect.Effect<HeadObjectResult, BackendError>;
  },
) => {
  const { url, token, client, headerService, checksumService, container } =
    target;

  return {
    createMultipartUpload: (
      key: string,
      headers: Record<string, string | string[] | undefined>,
    ) =>
      Effect.gen(function* () {
        const uploadId = yield* Effect.try({
          try: () => crypto.randomUUID(),
          catch: (e) => new InternalError({ message: String(e) }),
        });
        const { checksums } = headerService.fromRequestHeaders(headers);

        // Save metadata for later use in CompleteMultipartUpload
        const metadata: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers)) {
          const lowK = k.toLowerCase();
          if (
            lowK.startsWith("x-amz-meta-") ||
            lowK === "content-type" ||
            lowK.startsWith("x-amz-checksum-") ||
            lowK === "x-amz-sdk-checksum-algorithm"
          ) {
            metadata[lowK] = String(v);
          }
        }

        const finalChecksumAlgorithm = (
          checksums.algorithm ??
            metadata["x-amz-checksum-algorithm"] ??
            metadata["x-amz-sdk-checksum-algorithm"]
        )?.toUpperCase();
        const finalChecksumType = (
          checksums.type ??
            metadata["x-amz-checksum-type"]
        )?.toUpperCase();

        if (finalChecksumAlgorithm) {
          metadata["x-amz-checksum-algorithm"] = finalChecksumAlgorithm;
        }
        if (finalChecksumType) {
          metadata["x-amz-checksum-type"] = finalChecksumType;
        }

        yield* multipartMetadataStore.set(
          `${key}/${uploadId}`,
          JSON.stringify(metadata),
        ).pipe(
          Effect.tapError((e) =>
            Effect.logError("Metadata store set failed", {
              operation: "createMultipartUpload",
              error: String(e),
              key,
              uploadId,
            })
          ),
          Effect.mapError((e) =>
            new InternalError({
              message: `Failed to persist multipart upload metadata: ${
                String(e)
              }`,
            })
          ),
        );

        return {
          uploadId,
          checksumAlgorithm: finalChecksumAlgorithm,
          checksumType: finalChecksumType,
        } satisfies MultipartUploadResult;
      }),

    uploadPart: (
      _key: string,
      uploadId: string,
      partNumber: number,
      body: Stream.Stream<Uint8Array, Error>,
      headers: Record<string, string | string[] | undefined>,
    ) =>
      Effect.gen(function* () {
        const { checksums, metadata } = headerService.fromRequestHeaders(
          headers,
        );
        const segmentKey = `${MP_SEGMENTS_PREFIX}${uploadId}/${partNumber}`;
        const encodedSegmentKey = encodeObjectKeyForSwift(segmentKey);

        const swiftHeaders: Record<string, string> = {
          "X-Auth-Token": token,
          ...headerService.toSwiftHeaders(metadata, checksums),
        };

        const validatedStream = yield* checksumService.validate(
          body,
          checksums,
        );

        const request = HttpClientRequest.put(`${url}/${encodedSegmentKey}`)
          .pipe(
            HttpClientRequest.setHeaders(swiftHeaders),
            HttpClientRequest.bodyStream(validatedStream.pipe(
              Stream.mapError((e) => {
                return e;
              }),
            )),
          );

        const response: HttpClientResponse.HttpClientResponse = yield* client
          .execute(request).pipe(
            Effect.retry({
              while: (e) => {
                const s = String(e);
                return (s.includes("Transport error") ||
                  s.includes("ECONNRESET"));
              },
              schedule: Schedule.exponential("100 millis").pipe(
                Schedule.compose(Schedule.recurs(3)),
              ),
            }),
            Effect.catchAll((e) => {
              const s = String(e);
              if (
                s.includes("NoSuchKey") || s.includes("NoSuchBucket") ||
                s.includes("InvalidRequest") || s.includes("BadDigest")
              ) return Effect.fail(e as BackendError);
              return Effect.fail(
                mapError(
                  500,
                  formatSwiftTransportError(e),
                  container,
                  "PUT",
                  _key,
                ),
              );
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
          checksumAlgorithm: checksums.algorithm,
          checksumType: checksums.type,
          checksumCRC32: checksums.crc32,
          checksumCRC32C: checksums.crc32c,
          checksumCRC64NVME: checksums.crc64nvme,
          checksumSHA1: checksums.sha1,
          checksumSHA256: checksums.sha256,
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
      _metadataArg: Record<string, string>,
      headers: Record<string, string | string[] | undefined>,
    ) =>
      Effect.gen(function* () {
        if (parts.length === 0) {
          return yield* Effect.fail(
            new InvalidPart({
              message: "At least one part must be specified.",
            }),
          );
        }

        // Retrieve metadata from store
        const metadataOpt = yield* multipartMetadataStore.get(
          `${key}/${uploadId}`,
        ).pipe(
          Effect.mapError((e) => new InternalError({ message: String(e) })),
        );
        let metadata: Record<string, string> = {};
        if (Option.isSome(metadataOpt)) {
          try {
            metadata = JSON.parse(metadataOpt.value);
          } catch (e) {
            yield* Effect.logError("Parse multipart metadata failed", {
              operation: "completeMultipartUpload",
              key,
              uploadId,
              error: String(e),
            });
          }
        }

        const encodedKey = encodeObjectKeyForSwift(key);

        // Fetch segment info to get sizes
        const segmentMap = new Map<string, ObjectInfo>();
        const buildSegmentMap = Effect.gen(function* () {
          segmentMap.clear();
          let segmentMarker: string | undefined = undefined;
          while (true) {
            const segmentsResult: ListObjectsResult = yield* objectOps
              .listObjects({
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

        // 1. Build SLO manifest (Swift requires each segment >= 1 byte)
        const manifest = [];
        for (const p of parts) {
          const segmentKey = `${MP_SEGMENTS_PREFIX}${uploadId}/${p.partNumber}`;
          const info = segmentMap.get(segmentKey)!;
          if (info.size < 1) {
            return yield* Effect.fail(
              new InvalidPart({
                message:
                  `Part ${p.partNumber} has size 0; each part must be at least 1 byte`,
              }),
            );
          }
          manifest.push({
            path: `/${container}/${segmentKey}`,
            etag: p.etag.replace(/"/g, ""),
            size_bytes: info.size,
          });
        }

        // 2. PUT SLO manifest
        const { checksums } = headerService.fromRequestHeaders(headers);
        const swiftHeaders: Record<string, string> = {
          "X-Auth-Token": token,
          "Content-Type": (metadata["content-type"] ||
            "application/octet-stream") as string,
          ...headerService.toSwiftHeaders(metadata, checksums),
        };

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

        const response: HttpClientResponse.HttpClientResponse = yield* client
          .execute(request).pipe(
            Effect.mapError((e) =>
              mapError(500, formatSwiftTransportError(e), container)
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

        // 3. Cleanup metadata
        yield* multipartMetadataStore.remove(`${key}/${uploadId}`).pipe(
          Effect.mapError((e) => new InternalError({ message: String(e) })),
          Effect.ignore,
        );

        // 4. Cleanup segments metadata object if it exists (for compatibility)
        const metaKey = `${MP_META_PREFIX}${key}/${uploadId}`;
        const encodedMetaKey = encodeObjectKeyForSwift(metaKey);
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
          checksumAlgorithm: checksums.algorithm,
          checksumType: checksums.type || "COMPOSITE",
          checksumCRC32: checksums.crc32,
          checksumCRC32C: checksums.crc32c,
          checksumCRC64NVME: checksums.crc64nvme,
          checksumSHA1: checksums.sha1,
          checksumSHA256: checksums.sha256,
        } satisfies CompleteMultipartUploadResult;
      }),

    abortMultipartUpload: (
      key: string,
      uploadId: string,
    ) =>
      Effect.gen(function* () {
        // 1. Delete the segments
        let marker: string | undefined = undefined;
        while (true) {
          const segmentsResult: ListObjectsResult = yield* objectOps
            .listObjects({
              prefix: `${MP_SEGMENTS_PREFIX}${uploadId}/`,
              marker,
            });

          yield* Effect.all(
            segmentsResult.contents.map((content) => {
              const encodedKey = encodeObjectKeyForSwift(content.key);
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

        // 2. Delete metadata from store
        yield* multipartMetadataStore.remove(`${key}/${uploadId}`).pipe(
          Effect.ignore,
        );

        // 3. Delete metadata object (compatibility)
        const metaKey = `${MP_META_PREFIX}${key}/${uploadId}`;
        const encodedMetaKey = encodeObjectKeyForSwift(metaKey);
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
    }) =>
      Effect.gen(function* () {
        const prefix = `${MP_META_PREFIX}${args.prefix ?? ""}`;
        const marker = args.keyMarker
          ? `${MP_META_PREFIX}${args.keyMarker}/${args.uploadIdMarker ?? ""}`
          : undefined;

        const metaResult = yield* objectOps.listObjects({
          prefix,
          delimiter: args.delimiter,
          maxKeys: args.maxUploads,
          marker,
        });

        const uploads: MultipartUploadInfo[] = [];
        for (const c of metaResult.contents) {
          // Remove prefix and split by "/"
          const keyWithoutPrefix = c.key.substring(MP_META_PREFIX.length);
          // Skip keys that end with "/" or are empty after prefix removal
          if (!keyWithoutPrefix || keyWithoutPrefix.endsWith("/")) {
            yield* Effect.logWarning("Skipping malformed metadata key", {
              operation: "listMultipartUploads",
              key: c.key,
            });
            continue;
          }

          const parts = keyWithoutPrefix.split("/");
          const uploadId = parts.pop();
          // Validate uploadId: must be present and non-empty
          if (!uploadId || uploadId === "") {
            yield* Effect.logWarning(
              "Skipping metadata key with missing uploadId",
              {
                operation: "listMultipartUploads",
                key: c.key,
              },
            );
            continue;
          }

          const key = parts.join("/");
          uploads.push({
            key,
            uploadId,
            owner: { id: "swift", displayName: "Swift User" },
            initiator: { id: "swift", displayName: "Swift User" },
            storageClass: "STANDARD",
            initiated: c.lastModified ?? new Date(),
          });
        }

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
    ) =>
      Effect.gen(function* () {
        // Check if upload exists by checking for metadata in store or object
        const metadataOpt = yield* multipartMetadataStore.get(
          `${key}/${uploadId}`,
        ).pipe(
          Effect.mapError((e) => new InternalError({ message: String(e) })),
        );
        if (Option.isNone(metadataOpt)) {
          const metaKey = `${MP_META_PREFIX}${key}/${uploadId}`;
          const encodedMetaKey = encodeObjectKeyForSwift(metaKey);
          const metaResponse: HttpClientResponse.HttpClientResponse =
            yield* client.execute(
              HttpClientRequest.head(`${url}/${encodedMetaKey}`).pipe(
                HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
              ),
            ).pipe(
              Effect.mapError((e) =>
                mapError(500, formatSwiftTransportError(e), container)
              ),
            );

          if (metaResponse.status === 200) {
            // Metadata object exists, continue processing
          } else if (metaResponse.status === 404) {
            return yield* Effect.fail(
              new NoSuchUpload({
                uploadId,
                message:
                  `The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.`,
              }),
            );
          } else {
            // Non-200/non-404 status: fail with descriptive error
            const errorMessage = yield* metaResponse.text.pipe(
              Effect.orElseSucceed(() => "Unknown error"),
            );
            return yield* Effect.fail(
              mapError(
                metaResponse.status,
                `Metadata HEAD failed for upload ${uploadId} in container ${container}: ${errorMessage}`,
                container,
                "HEAD",
                encodedMetaKey,
              ),
            );
          }
        }

        const segmentsResult = yield* objectOps.listObjects({
          prefix: `${MP_SEGMENTS_PREFIX}${uploadId}/`,
        });

        const parts: PartInfo[] = [];
        for (const c of segmentsResult.contents) {
          const keySegment = c.key.split("/").pop() || "0";
          const partNumber = parseInt(keySegment, 10);
          if (isNaN(partNumber) || partNumber <= 0) {
            yield* Effect.logWarning("Invalid part number in segment key", {
              operation: "listParts",
              key: c.key,
              parsed: keySegment,
            });
            continue;
          }
          parts.push({
            partNumber,
            lastModified: c.lastModified,
            etag: c.etag,
            size: c.size,
          });
        }

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
