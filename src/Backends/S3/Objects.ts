import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectAttributesCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsCommand,
  type ListObjectsCommandOutput,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  ListObjectVersionsCommand,
  type ObjectAttributes as S3ObjectAttributes,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { Chunk, Effect, Option, Stream } from "effect";
import { Readable } from "node-stream";
import type sweb from "node-stream/web";
import {
  AccessDenied,
  type BackendError,
  BadDigest,
  type CommonPrefix,
  type HeadObjectResult,
  InternalError,
  InvalidRequest,
  type ListObjectsResult,
  type ObjectInfo,
  type ObjectResponse,
} from "../../Services/Backend.ts";
import { normalizeHeaders } from "../../Services/S3HeaderService.ts";
import { stripAwsChunkedFromContentEncoding } from "../../Services/AwsChunked.ts";
import type {
  ChecksumAlgorithm,
  ChecksumType,
} from "../../Services/S3Schema.ts";
import { mapS3Error, type S3Target, stripMinioMetadata } from "./Utils.ts";

interface S3ChecksumFields {
  readonly ChecksumCRC32?: string;
  readonly ChecksumCRC32C?: string;
  readonly ChecksumCRC64NVME?: string;
  readonly ChecksumSHA1?: string;
  readonly ChecksumSHA256?: string;
  readonly ChecksumAlgorithm?: string;
  readonly ChecksumType?: string;
}

const mapS3ChecksumsToResult = (result: S3ChecksumFields) => ({
  checksumAlgorithm: result.ChecksumAlgorithm as ChecksumAlgorithm,
  checksumType: result.ChecksumType as ChecksumType,
  checksumCRC32: result.ChecksumCRC32,
  checksumCRC32C: result.ChecksumCRC32C,
  checksumCRC64NVME: result.ChecksumCRC64NVME,
  checksumSHA1: result.ChecksumSHA1,
  checksumSHA256: result.ChecksumSHA256,
});

export const makeObjectOps = (
  { client, bucketName, headerService, checksumService }: S3Target,
) => ({
  listObjects: (args: {
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
      if (args.listType === 2) {
        const result = yield* Effect.tryPromise({
          try: () =>
            client.send(
              new ListObjectsV2Command({
                Bucket: bucketName,
                Prefix: args.prefix,
                Delimiter: args.delimiter,
                MaxKeys: args.maxKeys,
                ContinuationToken: args.continuationToken,
                StartAfter: args.startAfter,
              }),
            ) as Promise<ListObjectsV2CommandOutput>,
          catch: (e) => mapS3Error(e, bucketName),
        });

        return {
          name: result.Name ?? bucketName,
          prefix: result.Prefix,
          maxKeys: result.MaxKeys ?? 1000,
          delimiter: result.Delimiter,
          isTruncated: result.IsTruncated ?? false,
          encodingType: args.encodingType,
          continuationToken: result.ContinuationToken,
          nextContinuationToken: result.NextContinuationToken,
          keyCount: result.KeyCount,
          listType: 2,
          contents: (result.Contents ?? []).map((c): ObjectInfo => ({
            key: stripMinioMetadata(c.Key ?? ""),
            lastModified: c.LastModified ?? new Date(),
            etag: c.ETag ?? "",
            size: c.Size ?? 0,
            storageClass: c.StorageClass,
            owner: c.Owner
              ? {
                id: c.Owner.ID ?? "unknown",
                displayName: c.Owner.DisplayName ?? "unknown",
              }
              : undefined,
          })),
          commonPrefixes: (result.CommonPrefixes ?? []).map((
            cp,
          ): CommonPrefix => ({
            prefix: stripMinioMetadata(cp.Prefix ?? ""),
          })),
        } satisfies ListObjectsResult;
      } else {
        const result = yield* Effect.tryPromise({
          try: () =>
            client.send(
              new ListObjectsCommand({
                Bucket: bucketName,
                Prefix: args.prefix,
                Delimiter: args.delimiter,
                Marker: args.marker,
                MaxKeys: args.maxKeys,
              }),
            ) as Promise<ListObjectsCommandOutput>,
          catch: (e) => mapS3Error(e, bucketName),
        });

        return {
          name: result.Name ?? bucketName,
          prefix: result.Prefix,
          marker: result.Marker,
          nextMarker: result.NextMarker,
          maxKeys: result.MaxKeys ?? 1000,
          delimiter: result.Delimiter,
          isTruncated: result.IsTruncated ?? false,
          encodingType: args.encodingType,
          listType: 1,
          contents: (result.Contents ?? []).map((c): ObjectInfo => ({
            key: stripMinioMetadata(c.Key ?? ""),
            lastModified: c.LastModified ?? new Date(),
            etag: c.ETag ?? "",
            size: c.Size ?? 0,
            storageClass: c.StorageClass,
            owner: c.Owner
              ? {
                id: c.Owner.ID ?? "unknown",
                displayName: c.Owner.DisplayName ?? "unknown",
              }
              : undefined,
          })),
          commonPrefixes: (result.CommonPrefixes ?? []).map((
            cp,
          ): CommonPrefix => ({
            prefix: stripMinioMetadata(cp.Prefix ?? ""),
          })),
        } satisfies ListObjectsResult;
      }
    }),

  listVersions: (args: {
    prefix?: string;
    delimiter?: string;
    keyMarker?: string;
    versionIdMarker?: string;
    maxKeys?: number;
    encodingType?: string;
  }) =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: () =>
          client.send(
            new ListObjectVersionsCommand({
              Bucket: bucketName,
              Prefix: args.prefix,
              Delimiter: args.delimiter,
              KeyMarker: args.keyMarker,
              // MinIO skips one extra entry when resuming with
              // version-id-marker="null" (its id for unversioned objects)
              // after the marker entry has been deleted; a key-only resume is
              // exact. Clients need the marker in the response, so drop it here.
              VersionIdMarker: args.versionIdMarker === "null"
                ? undefined
                : args.versionIdMarker,
              MaxKeys: args.maxKeys,
            }),
          ),
        catch: (e) => mapS3Error(e, bucketName),
      });

      const contents: ObjectInfo[] = [
        ...(result.Versions ?? []).map((v): ObjectInfo => ({
          key: stripMinioMetadata(v.Key ?? ""),
          lastModified: v.LastModified ?? new Date(),
          etag: v.ETag ?? "",
          size: v.Size ?? 0,
          storageClass: v.StorageClass,
          versionId: v.VersionId,
          isDeleteMarker: false,
          isLatest: v.IsLatest,
          owner: v.Owner
            ? {
              id: v.Owner.ID ?? "unknown",
              displayName: v.Owner.DisplayName ?? "unknown",
            }
            : undefined,
        })),
        ...(result.DeleteMarkers ?? []).map((dm): ObjectInfo => ({
          key: stripMinioMetadata(dm.Key ?? ""),
          lastModified: dm.LastModified ?? new Date(),
          etag: "",
          size: 0,
          versionId: dm.VersionId,
          isDeleteMarker: true,
          isLatest: dm.IsLatest,
          owner: dm.Owner
            ? {
              id: dm.Owner.ID ?? "unknown",
              displayName: dm.Owner.DisplayName ?? "unknown",
            }
            : undefined,
        })),
      ];
      // S3 requires NextKeyMarker/NextVersionIdMarker on truncated listings.
      // MinIO omits NextVersionIdMarker for unversioned buckets; the last
      // entry's version id (the literal "null" there) is a valid page marker.
      // Clients like botocore fail the request outright when it is missing.
      //
      // MinIO's NextKeyMarker carries an internal bracket suffix (e.g.
      // "0/1126[minio_cache:v2,return:]"). Resuming from such a marker after
      // the marker object has been deleted skips one extra entry, so derive
      // the marker from the last entry actually returned instead.
      const lastContent = contents[contents.length - 1];
      const isTruncated = result.IsTruncated ?? false;
      const nextVersionIdMarker = result.NextVersionIdMarker ||
        (isTruncated ? lastContent?.versionId : undefined);

      return {
        name: result.Name ?? bucketName,
        prefix: result.Prefix,
        marker: result.KeyMarker,
        nextMarker: isTruncated && lastContent
          ? lastContent.key
          : result.NextKeyMarker,
        maxKeys: result.MaxKeys ?? 1000,
        delimiter: result.Delimiter,
        isTruncated: result.IsTruncated ?? false,
        encodingType: args.encodingType,
        listType: 1,
        contents,
        // formatListVersions renders this element as <NextVersionIdMarker>
        nextContinuationToken: nextVersionIdMarker,
        commonPrefixes: (result.CommonPrefixes ?? []).map((
          cp,
        ): CommonPrefix => ({
          prefix: stripMinioMetadata(cp.Prefix ?? ""),
        })),
      } satisfies ListObjectsResult;
    }),

  getObject: (
    key: string,
    headers: Record<string, string | string[] | undefined>,
  ) =>
    Effect.gen(function* () {
      const normalized = normalizeHeaders(headers);
      const { s3Params } = headerService.fromRequestHeaders(headers);

      const result = yield* Effect.tryPromise({
        try: () =>
          client.send(
            new GetObjectCommand({
              Bucket: bucketName,
              Key: key,
              Range: normalized["range"],
              PartNumber: s3Params.partNumber,
              VersionId: s3Params.versionId,
              ChecksumMode: s3Params.checksumMode as "ENABLED",
              IfMatch: normalized["if-match"],
              IfNoneMatch: normalized["if-none-match"],
              IfModifiedSince: normalized["if-modified-since"]
                ? new Date(normalized["if-modified-since"] as string)
                : undefined,
              IfUnmodifiedSince: normalized["if-unmodified-since"]
                ? new Date(normalized["if-unmodified-since"] as string)
                : undefined,
            }),
          ),
        catch: (e) => mapS3Error(e, bucketName),
      });

      const body = result.Body;
      if (!body) {
        return yield* Effect.fail(
          new InternalError({
            message: "S3 returned empty body for GetObject",
          }),
        );
      }

      const getWebStream = (): ReadableStream<Uint8Array> => {
        if (
          body && typeof body === "object" &&
          "transformToWebStream" in body
        ) {
          const b = body as { transformToWebStream: unknown };
          if (typeof b.transformToWebStream === "function") {
            return b.transformToWebStream() as ReadableStream<
              Uint8Array
            >;
          }
        }
        return body as ReadableStream<Uint8Array>;
      };

      const webStream = getWebStream();
      const stream: Stream.Stream<Uint8Array, Error> = Stream
        .fromReadableStream(
          () => webStream,
          (e) => new Error(String(e)),
        );

      const metadata: Record<string, string> = {};
      if (result.Metadata) {
        for (const [k, v] of Object.entries(result.Metadata)) {
          metadata[k] = v.includes("%")
            ? Option.liftThrowable(decodeURIComponent)(v).pipe(
              Option.getOrElse(() => v),
            )
            : v;
        }
      }

      const responseResult: ObjectResponse = {
        stream,
        nativeStream: webStream,
        contentType: result.ContentType,
        contentEncoding: result.ContentEncoding,
        contentLength: result.ContentLength,
        etag: result.ETag,
        lastModified: result.LastModified,
        metadata,
        partsCount: result.PartsCount,
        headers: headerService.toResponseHeaders({
          ...mapS3ChecksumsToResult(result as S3ChecksumFields),
          metadata,
          headers: {},
          partsCount: result.PartsCount,
          contentLength: result.ContentLength,
          contentType: result.ContentType,
          contentEncoding: result.ContentEncoding,
          etag: result.ETag,
          lastModified: result.LastModified,
        }),
        ...mapS3ChecksumsToResult(result as S3ChecksumFields),
      };

      return responseResult;
    }),

  headObject: (
    key: string,
    headers: Record<string, string | string[] | undefined>,
  ) =>
    Effect.gen(function* () {
      const { s3Params } = headerService.fromRequestHeaders(headers);

      const commandInput = {
        Bucket: bucketName,
        Key: key,
        PartNumber: s3Params.partNumber,
        ChecksumMode: s3Params.checksumMode as "ENABLED",
      };
      const result = yield* Effect.tryPromise({
        try: () => client.send(new HeadObjectCommand(commandInput)),
        catch: (e) => mapS3Error(e, bucketName),
      });

      const metadata: Record<string, string> = {};
      if (result.Metadata) {
        for (const [k, v] of Object.entries(result.Metadata)) {
          metadata[k] = v.includes("%")
            ? Option.liftThrowable(decodeURIComponent)(v).pipe(
              Option.getOrElse(() => v),
            )
            : v;
        }
      }

      return {
        contentType: result.ContentType,
        contentEncoding: result.ContentEncoding,
        contentLength: result.ContentLength,
        etag: result.ETag,
        lastModified: result.LastModified,
        metadata,
        partsCount: result.PartsCount,
        headers: headerService.toResponseHeaders({
          ...mapS3ChecksumsToResult(result as S3ChecksumFields),
          metadata,
          headers: {},
          partsCount: result.PartsCount,
          contentLength: result.ContentLength,
          contentType: result.ContentType,
          contentEncoding: result.ContentEncoding,
          etag: result.ETag,
          lastModified: result.LastModified,
        }),
        ...mapS3ChecksumsToResult(result as S3ChecksumFields),
      } satisfies HeadObjectResult;
    }),

  putObject: (
    key: string,
    bodyStream: Stream.Stream<Uint8Array, Error>,
    headers: Record<string, string | string[] | undefined>,
  ) =>
    Effect.gen(function* () {
      const { checksums, metadata, s3Params } = headerService
        .fromRequestHeaders(headers);
      const normalized = normalizeHeaders(headers);

      const contentType = normalized["content-type"]!;
      const contentEncoding = stripAwsChunkedFromContentEncoding(
        normalized["content-encoding"],
      );
      let contentLength = s3Params.contentLength;

      const validatedStream = (yield* checksumService.validate(
        bodyStream,
        checksums,
      )).pipe(
        Stream.catchAll((e) => {
          // Preserve known S3-compatible errors from checksum/chunk-signature validation.
          if (
            e instanceof BadDigest ||
            e instanceof InvalidRequest ||
            e instanceof AccessDenied
          ) {
            return Stream.fail(e as BackendError);
          }
          return Stream.fail(
            new InternalError({
              message: `error on checksum stream: ${String(e)}`,
            }),
          );
        }),
      );

      const shouldBuffer = contentLength === undefined ||
        contentLength < 1024 * 1024;

      const body = shouldBuffer
        ? yield* Stream.runCollect(validatedStream).pipe(
          Effect.map((chunks) => {
            const total = Chunk.reduce(chunks, 0, (acc, c) => acc + c.length);
            const res = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) {
              res.set(c, off);
              off += c.length;
            }
            // For chunked transfer uploads without Content-Length, infer exact size.
            if (contentLength === undefined) {
              contentLength = total;
            }
            return res;
          }),
          Effect.mapError((e) => {
            if (e instanceof InvalidRequest) return e;
            if (e instanceof BadDigest) return e;
            return new InternalError({
              message: `error collecting body stream into memory: ${String(e)}`,
            });
          }),
        )
        : Readable.fromWeb(
          Stream.toReadableStream(validatedStream) as sweb.ReadableStream,
        );

      const result = yield* Effect.tryPromise({
        try: () => {
          const command = new PutObjectCommand({
            Bucket: bucketName,
            Key: key,
            Body: body,
            ContentType: contentType,
            ContentEncoding: contentEncoding,
            ContentLength: contentLength,
            Metadata: metadata,
          });

          // If it's a Node stream, add an error handler to prevent uncaught exceptions
          // from the stream itself, as we handle failures through the send() promise.
          if (body instanceof Readable) {
            body.on("error", (err: unknown) => {
              // Log at debug level for debugging purposes, but don't throw
              // as we handle failures through the send() promise
              Effect.logDebug("Stream error", {
                operation: "putObject",
                context: "handled by send() promise",
                error: String(err),
              }).pipe(
                Effect.runPromise,
              ).catch(() => {
                // Ignore logging errors
              });
            });
          }

          // Remove checksum middlewares to prevent them from trying to hash the stream twice
          command.middlewareStack.remove("flexibleChecksumsMiddleware");
          command.middlewareStack.remove("getChecksumMiddleware");

          // Manually inject validated checksums
          if (
            checksums.sha256 || checksums.sha1 || checksums.crc32 ||
            checksums.crc32c || checksums.crc64nvme || !shouldBuffer
          ) {
            command.middlewareStack.add(
              (next) => (args) => {
                const request = args.request as {
                  headers: Record<string, string>;
                  duplex?: string;
                };
                if (!shouldBuffer) {
                  request.duplex = "half";
                  request.headers["x-amz-content-sha256"] = "UNSIGNED-PAYLOAD";
                  if (contentLength !== undefined) {
                    request.headers["content-length"] = String(contentLength);
                  }
                }
                if (checksums.sha256) {
                  request.headers["x-amz-checksum-sha256"] = checksums.sha256;
                }
                if (checksums.sha1) {
                  request.headers["x-amz-checksum-sha1"] = checksums.sha1;
                }
                if (checksums.crc32) {
                  request.headers["x-amz-checksum-crc32"] = checksums.crc32;
                }
                if (checksums.crc32c) {
                  request.headers["x-amz-checksum-crc32c"] = checksums.crc32c;
                }
                if (checksums.crc64nvme) {
                  request.headers["x-amz-checksum-crc64nvme"] =
                    checksums.crc64nvme;
                }
                return next(args);
              },
              { step: "build", name: "ManualChecksumInjection" },
            );
          }

          return client.send(command);
        },
        catch: (e) => mapS3Error(e, bucketName),
      });

      return {
        etag: result.ETag,
        versionId: result.VersionId,
        ...mapS3ChecksumsToResult(result as S3ChecksumFields),
      };
    }),

  deleteObject: (key: string) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () =>
          client.send(
            new DeleteObjectCommand({
              Bucket: bucketName,
              Key: key,
            }),
          ),
        catch: (e) => mapS3Error(e, bucketName),
      });
    }),

  deleteObjects: (objects: readonly { key: string; versionId?: string }[]) =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: () =>
          client.send(
            new DeleteObjectsCommand({
              Bucket: bucketName,
              Delete: {
                Objects: objects.map((o) => ({
                  Key: o.key,
                  VersionId: o.versionId === "null" ? undefined : o.versionId,
                })),
              },
            }),
          ),
        catch: (e) => mapS3Error(e, bucketName),
      });

      return {
        deleted: (result.Deleted ?? []).map((d) => d.Key ?? ""),
        errors: (result.Errors ?? []).map((e) => ({
          key: e.Key ?? "unknown",
          code: e.Code ?? "InternalError",
          message: e.Message ?? "Unknown error",
        })),
      };
    }),

  getObjectAttributes: (
    key: string,
    attributes: readonly string[],
    headers: Record<string, string | string[] | undefined>,
  ) =>
    Effect.gen(function* () {
      const { s3Params } = headerService.fromRequestHeaders(headers);

      // Map attribute names to what S3 SDK expects (case-sensitive)
      const s3Attributes = attributes
        .map((a) => {
          const lower = a.toLowerCase();
          if (lower === "etag") return "ETag";
          if (lower === "checksum") return "Checksum";
          if (lower === "objectparts") return "ObjectParts";
          if (lower === "objectsize") return "ObjectSize";
          if (lower === "storageclass") return "StorageClass";
          return undefined;
        })
        .filter((a): a is S3ObjectAttributes => a !== undefined);

      if (s3Attributes.length === 0) {
        // If no recognized attributes, return a sensible default or fail?
        // S3 requires at least one.
        return yield* Effect.fail(mapS3Error({
          name: "InvalidArgument",
          message: "At least one valid attribute must be specified.",
        }, bucketName));
      }

      const result = yield* Effect.tryPromise({
        try: () =>
          client.send(
            new GetObjectAttributesCommand({
              Bucket: bucketName,
              Key: key,
              ObjectAttributes: s3Attributes,
              VersionId: s3Params.versionId,
            }),
          ),
        catch: (e) => mapS3Error(e, bucketName),
      });

      return {
        etag: result.ETag,
        checksum: result.Checksum
          ? {
            checksumCRC32: result.Checksum.ChecksumCRC32,
            checksumCRC32C: result.Checksum.ChecksumCRC32C,
            checksumCRC64NVME: result.Checksum.ChecksumCRC64NVME,
            checksumSHA1: result.Checksum.ChecksumSHA1,
            checksumSHA256: result.Checksum.ChecksumSHA256,
            checksumType: result.Checksum.ChecksumType,
          }
          : undefined,
        objectParts: result.ObjectParts
          ? {
            totalPartsCount: result.ObjectParts.TotalPartsCount,
            partNumberMarker: result.ObjectParts.PartNumberMarker
              ? parseInt(String(result.ObjectParts.PartNumberMarker))
              : undefined,
            nextPartNumberMarker: result.ObjectParts.NextPartNumberMarker
              ? parseInt(String(result.ObjectParts.NextPartNumberMarker))
              : undefined,
            maxParts: result.ObjectParts.MaxParts,
            isTruncated: result.ObjectParts.IsTruncated,
            parts: (result.ObjectParts.Parts ?? []).map((p) => ({
              partNumber: p.PartNumber ?? 0,
              etag: "", // GetObjectAttributes doesn't return ETag for parts
              size: p.Size ?? 0,
              lastModified: undefined,
              checksumCRC32: p.ChecksumCRC32,
              checksumCRC32C: p.ChecksumCRC32C,
              checksumCRC64NVME: p.ChecksumCRC64NVME,
              checksumSHA1: p.ChecksumSHA1,
              checksumSHA256: p.ChecksumSHA256,
            })),
          }
          : undefined,
        objectSize: result.ObjectSize,
        storageClass: result.StorageClass,
      };
    }),

  copyObject: (
    sourceKey: string,
    destKey: string,
    metadataDirective: "COPY" | "REPLACE",
    headers: Record<string, string | string[] | undefined>,
    sourceBucket?: string,
  ) =>
    Effect.gen(function* () {
      const srcBucket = sourceBucket || bucketName;
      const { s3Params, metadata } = headerService.fromRequestHeaders(headers);

      const result = yield* Effect.tryPromise({
        try: () =>
          client.send(
            new CopyObjectCommand({
              Bucket: bucketName,
              Key: destKey,
              CopySource: `${encodeURIComponent(srcBucket)}/${
                encodeURIComponent(
                  sourceKey,
                )
              }${s3Params.versionId ? `?versionId=${s3Params.versionId}` : ""}`,
              MetadataDirective: metadataDirective,
              Metadata: metadataDirective === "REPLACE" ? metadata : undefined,
            }),
          ),
        catch: (e) => mapS3Error(e, bucketName),
      });

      return {
        etag: result.CopyObjectResult?.ETag,
        versionId: result.VersionId,
        lastModified: result.CopyObjectResult?.LastModified,
      };
    }),
});
