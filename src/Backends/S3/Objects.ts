import { Chunk, Effect, Option, Stream } from "effect";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectAttributesCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsCommand,
  type ListObjectsCommandOutput,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  ListObjectVersionsCommand,
  ListPartsCommand,
  type ObjectAttributes as S3ObjectAttributes,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import {
  type BackendError,
  type CommonPrefix,
  type CompleteMultipartUploadResult,
  type HeadObjectResult,
  InternalError,
  InvalidRequest,
  type ListObjectsResult,
  type MultipartUploadResult,
  type ObjectAttributes,
  type ObjectInfo,
  type ObjectResponse,
  type PutObjectResult,
  type UploadPartResult,
} from "../../Services/Backend.ts";
import type {
  ChecksumAlgorithm,
  ChecksumType,
} from "../../Services/S3Schema.ts";
import { mapS3Error, type S3Target, stripMinioMetadata } from "./Utils.ts";
import {
  normalizeHeaders,
  S3HeaderService,
} from "../../Services/S3HeaderService.ts";
import { Checksum } from "../../Services/Checksum.ts";

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

export const makeObjectOps = (target: S3Target) => ({
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
      const { client, bucketName } = target;
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
      const { client, bucketName } = target;
      const result = yield* Effect.tryPromise({
        try: () =>
          client.send(
            new ListObjectVersionsCommand({
              Bucket: bucketName,
              Prefix: args.prefix,
              Delimiter: args.delimiter,
              KeyMarker: args.keyMarker,
              VersionIdMarker: args.versionIdMarker,
              MaxKeys: args.maxKeys,
            }),
          ),
        catch: (e) => mapS3Error(e, bucketName),
      });

      return {
        name: result.Name ?? bucketName,
        prefix: result.Prefix,
        marker: result.KeyMarker,
        nextMarker: result.NextKeyMarker,
        maxKeys: result.MaxKeys ?? 1000,
        delimiter: result.Delimiter,
        isTruncated: result.IsTruncated ?? false,
        encodingType: args.encodingType,
        listType: 1,
        contents: [
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
        ],
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
  ): Effect.Effect<ObjectResponse, BackendError, S3HeaderService> =>
    Effect.gen(function* () {
      const { client, bucketName } = target;
      const headerService = yield* S3HeaderService;
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
        contentLength: result.ContentLength,
        etag: result.ETag,
        lastModified: result.LastModified,
        metadata,
        partsCount: result.PartsCount,
        headers: headerService.toResponseHeaders({
          ...mapS3ChecksumsToResult(result as S3ChecksumFields),
          metadata,
          headers: {},
          stream: Stream.empty,
          partsCount: result.PartsCount,
          contentLength: result.ContentLength,
          contentType: result.ContentType,
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
  ): Effect.Effect<HeadObjectResult, BackendError, S3HeaderService> =>
    Effect.gen(function* () {
      const { client, bucketName } = target;
      const headerService = yield* S3HeaderService;
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
  ): Effect.Effect<
    PutObjectResult,
    BackendError,
    Checksum | S3HeaderService
  > =>
    Effect.gen(function* () {
      const { client, bucketName } = target;
      const headerService = yield* S3HeaderService;
      const { checksums, metadata, s3Params } = headerService
        .fromRequestHeaders(headers);
      const _normalized = normalizeHeaders(headers);

      const contentType = _normalized["content-type"] as string;
      const contentLength = s3Params.contentLength;

      yield* Effect.logDebug(
        `PutObject key=[${key}] checksums: algo=[${checksums.algorithm}] sha256=[${checksums.sha256}] crc32=[${checksums.crc32}] crc32c=[${checksums.crc32c}] headers=[${
          JSON.stringify(_normalized)
        }]`,
      );

      const checksumService = yield* Checksum;
      const validatedStream = yield* checksumService.validate(
        bodyStream,
        checksums,
      );

      const body = (contentLength !== undefined && contentLength > 1024 * 1024)
        ? Stream.toReadableStream(validatedStream.pipe(
          Stream.mapError((e) => new Error(String(e))),
        ))
        : yield* Effect.gen(function* () {
          const chunks = yield* Stream.runCollect(validatedStream).pipe(
            Effect.mapError((e) => {
              if (e instanceof InvalidRequest) return e;
              return new InternalError({ message: String(e) });
            }),
          );
          const totalLength = Chunk.reduce(
            chunks,
            0,
            (acc, chunk) => acc + chunk.length,
          );
          const body = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.length;
          }
          return body;
        });

      yield* Effect.logDebug(
        `PutObject key=[${key}] streaming body (contentLength=${contentLength})`,
      );

      const result = yield* Effect.tryPromise({
        try: () =>
          client.send(
            new PutObjectCommand({
              Bucket: bucketName,
              Key: key,
              Body: body, // SDK accepts ReadableStream or Uint8Array
              ContentType: contentType,
              ContentLength: contentLength,
              Metadata: metadata,
              ChecksumAlgorithm: checksums.algorithm,
              ChecksumCRC32: checksums.crc32,
              ChecksumCRC32C: checksums.crc32c,
              ChecksumCRC64NVME: checksums.crc64nvme,
              ChecksumSHA1: checksums.sha1,
              ChecksumSHA256: checksums.sha256,
            }),
          ),
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
      const { client, bucketName } = target;
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
      const { client, bucketName } = target;
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
  ): Effect.Effect<ObjectAttributes, BackendError, S3HeaderService> =>
    Effect.gen(function* () {
      const { client, bucketName } = target;
      const headerService = yield* S3HeaderService;
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

      yield* Effect.logDebug(
        `getObjectAttributes key=[${key}] s3Attributes=[${
          s3Attributes.join(",")
        }]`,
      );

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

  createMultipartUpload: (
    key: string,
    headers: Record<string, string | string[] | undefined>,
  ): Effect.Effect<MultipartUploadResult, BackendError, S3HeaderService> =>
    Effect.gen(function* () {
      const { client, bucketName } = target;
      const headerService = yield* S3HeaderService;

      const { checksums, metadata } = headerService.fromRequestHeaders(headers);
      const normalized = normalizeHeaders(headers);

      const command = new CreateMultipartUploadCommand({
        Bucket: bucketName,
        Key: key,
        Metadata: metadata,
        ContentType: normalized["content-type"] as string,
        ChecksumAlgorithm: checksums.algorithm,
        ChecksumType: checksums.type,
      });
      const response = yield* Effect.tryPromise({
        try: () => client.send(command),
        catch: (e) => mapS3Error(e, bucketName),
      });
      return {
        uploadId: response.UploadId!,
        checksumAlgorithm: response.ChecksumAlgorithm,
        checksumType: response.ChecksumType,
      } satisfies MultipartUploadResult;
    }),

  uploadPart: (
    key: string,
    uploadId: string,
    partNumber: number,
    bodyStream: Stream.Stream<Uint8Array, Error>,
    headers: Record<string, string | string[] | undefined>,
  ): Effect.Effect<
    UploadPartResult,
    BackendError,
    Checksum | S3HeaderService
  > =>
    Effect.gen(function* () {
      const { client, bucketName } = target;
      const headerService = yield* S3HeaderService;

      const { checksums, s3Params } = headerService.fromRequestHeaders(headers);
      const _normalized = normalizeHeaders(headers);

      const contentLength = s3Params.contentLength;

      const checksumService = yield* Checksum;
      const validatedStream = yield* checksumService.validate(
        bodyStream,
        checksums,
      );

      const body = yield* Effect.gen(function* () {
        const chunks = yield* Stream.runCollect(validatedStream).pipe(
          Effect.mapError((e) => {
            if (e instanceof InvalidRequest) return e;
            return new InternalError({ message: String(e) });
          }),
        );
        const totalLength = Chunk.reduce(
          chunks,
          0,
          (acc, chunk) => acc + chunk.length,
        );
        const body = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.length;
        }
        return body;
      });

      const result = yield* Effect.tryPromise({
        try: () =>
          client.send(
            new UploadPartCommand({
              Bucket: bucketName,
              Key: key,
              UploadId: uploadId,
              PartNumber: partNumber,
              Body: body, // SDK accepts ReadableStream or Uint8Array
              ContentLength: contentLength,
              ChecksumAlgorithm: checksums.algorithm,
              ChecksumCRC32: checksums.crc32,
              ChecksumCRC32C: checksums.crc32c,
              ChecksumCRC64NVME: checksums.crc64nvme,
              ChecksumSHA1: checksums.sha1,
              ChecksumSHA256: checksums.sha256,
            }),
          ),
        catch: (e) => mapS3Error(e, bucketName),
      });

      if (!result.ETag) {
        return yield* Effect.fail(
          new InternalError({
            message: "S3 returned empty ETag for UploadPart",
          }),
        );
      }
      return {
        etag: result.ETag,
        ...mapS3ChecksumsToResult(result as S3ChecksumFields),
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
    _metadata: Record<string, string>,
    headers: Record<string, string | string[] | undefined>,
  ): Effect.Effect<
    CompleteMultipartUploadResult,
    BackendError,
    S3HeaderService
  > =>
    Effect.gen(function* () {
      const { client, bucketName } = target;
      const headerService = yield* S3HeaderService;

      const { checksums } = headerService.fromRequestHeaders(headers);

      const result = yield* Effect.tryPromise({
        try: () =>
          client.send(
            new CompleteMultipartUploadCommand({
              Bucket: bucketName,
              Key: key,
              UploadId: uploadId,
              MultipartUpload: {
                Parts: parts.map((p) => ({
                  ETag: p.etag,
                  PartNumber: p.partNumber,
                  ChecksumCRC32: p.checksumCRC32,
                  ChecksumCRC32C: p.checksumCRC32C,
                  ChecksumCRC64NVME: p.checksumCRC64NVME,
                  ChecksumSHA1: p.checksumSHA1,
                  ChecksumSHA256: p.checksumSHA256,
                })),
              },
              ChecksumCRC32: checksums.crc32,
              ChecksumCRC32C: checksums.crc32c,
              ChecksumCRC64NVME: checksums.crc64nvme,
              ChecksumSHA1: checksums.sha1,
              ChecksumSHA256: checksums.sha256,
              ChecksumType: checksums.type,
            }),
          ),
        catch: (e) => mapS3Error(e, bucketName),
      });

      if (
        !result.Location || !result.Bucket || !result.Key ||
        !result.ETag
      ) {
        return yield* Effect.fail(
          new InternalError({
            message: "S3 returned incomplete CompleteMultipartUploadResult",
          }),
        );
      }
      const checksumResult = result as S3ChecksumFields;
      return {
        location: result.Location,
        bucket: result.Bucket,
        key: result.Key,
        etag: result.ETag,
        versionId: result.VersionId,
        checksumAlgorithm: checksumResult.ChecksumAlgorithm,
        checksumType: checksumResult.ChecksumType,
        checksumCRC32: result.ChecksumCRC32,
        checksumCRC32C: result.ChecksumCRC32C,
        checksumCRC64NVME: result.ChecksumCRC64NVME,
        checksumSHA1: result.ChecksumSHA1,
        checksumSHA256: result.ChecksumSHA256,
      } satisfies CompleteMultipartUploadResult;
    }),

  abortMultipartUpload: (key: string, uploadId: string) =>
    Effect.gen(function* () {
      const { client, bucketName } = target;
      yield* Effect.tryPromise({
        try: () =>
          client.send(
            new AbortMultipartUploadCommand({
              Bucket: bucketName,
              Key: key,
              UploadId: uploadId,
            }),
          ),
        catch: (e) => mapS3Error(e, bucketName),
      });
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
      const { client, bucketName } = target;
      const result = yield* Effect.tryPromise({
        try: () =>
          client.send(
            new ListMultipartUploadsCommand({
              Bucket: bucketName,
              Prefix: args.prefix,
              Delimiter: args.delimiter,
              KeyMarker: args.keyMarker,
              UploadIdMarker: args.uploadIdMarker,
              MaxUploads: args.maxUploads,
              EncodingType: args.encodingType as "url" | undefined,
            }),
          ),
        catch: (e) => mapS3Error(e, bucketName),
      });

      return {
        bucket: result.Bucket ?? bucketName,
        prefix: result.Prefix,
        keyMarker: result.KeyMarker,
        uploadIdMarker: result.UploadIdMarker,
        nextKeyMarker: result.NextKeyMarker,
        nextUploadIdMarker: result.NextUploadIdMarker,
        maxUploads: result.MaxUploads ?? 1000,
        delimiter: result.Delimiter,
        isTruncated: result.IsTruncated ?? false,
        encodingType: result.EncodingType ?? "",
        uploads: (result.Uploads ?? []).map((u) => ({
          key: u.Key ?? "",
          uploadId: u.UploadId ?? "",
          owner: {
            id: u.Owner?.ID ?? "",
            displayName: u.Owner?.DisplayName ?? "",
          },
          initiator: {
            id: u.Initiator?.ID ?? "",
            displayName: u.Initiator?.DisplayName ?? "",
          },
          storageClass: u.StorageClass ?? "STANDARD",
          initiated: u.Initiated ?? new Date(),
        })),
        commonPrefixes: (result.CommonPrefixes ?? []).map((cp) => ({
          prefix: cp.Prefix ?? "",
        })),
      };
    }),

  listParts: (key: string, uploadId: string) =>
    Effect.gen(function* () {
      const { client, bucketName } = target;
      const result = yield* Effect.tryPromise({
        try: () =>
          client.send(
            new ListPartsCommand({
              Bucket: bucketName,
              Key: key,
              UploadId: uploadId,
            }),
          ),
        catch: (e) => mapS3Error(e, bucketName),
      });

      return {
        bucket: result.Bucket ?? bucketName,
        key: result.Key ?? key,
        uploadId: result.UploadId ?? uploadId,
        owner: {
          id: result.Owner?.ID ?? "",
          displayName: result.Owner?.DisplayName ?? "",
        },
        initiator: {
          id: result.Initiator?.ID ?? "",
          displayName: result.Initiator?.DisplayName ?? "",
        },
        storageClass: result.StorageClass ?? "STANDARD",
        partNumberMarker: result.PartNumberMarker
          ? parseInt(String(result.PartNumberMarker))
          : 0,
        nextPartNumberMarker: result.NextPartNumberMarker
          ? parseInt(String(result.NextPartNumberMarker))
          : 0,
        maxParts: result.MaxParts ?? 1000,
        isTruncated: result.IsTruncated ?? false,
        parts: (result.Parts ?? []).map((p) => ({
          partNumber: p.PartNumber ?? 0,
          lastModified: p.LastModified ?? new Date(),
          etag: p.ETag ?? "",
          size: p.Size ?? 0,
          checksumCRC32: p.ChecksumCRC32,
          checksumCRC32C: p.ChecksumCRC32C,
          checksumCRC64NVME: p.ChecksumCRC64NVME,
          checksumSHA1: p.ChecksumSHA1,
          checksumSHA256: p.ChecksumSHA256,
        })),
      };
    }),
});
