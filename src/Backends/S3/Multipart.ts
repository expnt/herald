import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { Effect, Stream } from "effect";
import { Readable } from "node-stream";
import type sweb from "node-stream/web";
import {
  BadDigest,
  type CompleteMultipartUploadResult,
  InternalError,
  InvalidRequest,
  type ListMultipartUploadsResult,
  type ListPartsResult,
  type MultipartUploadResult,
  type UploadPartResult,
} from "../../Services/Backend.ts";
import { normalizeHeaders } from "../../Services/S3HeaderService.ts";
import type {
  ChecksumAlgorithm,
  ChecksumType,
} from "../../Services/S3Schema.ts";
import { mapS3Error, type S3Target } from "./Utils.ts";

interface S3ChecksumFields {
  readonly ChecksumCRC32?: string;
  readonly ChecksumCRC32C?: string;
  readonly ChecksumCRC64NVME?: string;
  readonly ChecksumSHA1?: string;
  readonly ChecksumSHA256?: string;
  readonly ChecksumAlgorithm?: string;
  readonly ChecksumType?: string;
}

export const makeMultipartOps = (
  { client, bucketName, headerService, checksumService }: S3Target,
) => ({
  createMultipartUpload: (
    key: string,
    headers: Record<string, string | string[] | undefined>,
  ) =>
    Effect.gen(function* () {
      const { checksums, metadata } = headerService.fromRequestHeaders(headers);
      const normalized = normalizeHeaders(headers);

      // Don't pass ChecksumAlgorithm to avoid SDK enabling checksum validation for uploadPart
      // The SDK's checksum middleware converts Buffer to ReadableStream for validation,
      // causing "Received an instance of ReadableStream" errors with Node.js crypto.
      // We'll validate checksums ourselves and return them in the response headers.
      const command = new CreateMultipartUploadCommand({
        Bucket: bucketName,
        Key: key,
        Metadata: metadata,
        ContentType: normalized["content-type"] as string,
        // Intentionally NOT passing ChecksumAlgorithm or ChecksumType to avoid SDK validation
      });

      if (checksums.algorithm) {
        command.middlewareStack.add(
          (next) => (args) => {
            const request = args.request as { headers: Record<string, string> };
            request.headers["x-amz-checksum-algorithm"] = checksums.algorithm!
              .toUpperCase();
            return next(args);
          },
          { step: "build", name: "ManualAlgorithmInjection" },
        );
      }

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
  ) =>
    Effect.gen(function* () {
      const { checksums, s3Params } = headerService.fromRequestHeaders(headers);

      const contentLength = s3Params.contentLength;

      const validatedStream = yield* checksumService.validate(
        bodyStream,
        checksums,
      );

      const body = Readable.fromWeb(
        Stream.toReadableStream(validatedStream.pipe(
          Stream.mapError((e) => {
            if (e instanceof BadDigest) return e;
            if (e instanceof InvalidRequest) return e;
            return new InternalError({ message: String(e) });
          }),
        )) as sweb.ReadableStream,
      );

      // Build command WITHOUT any checksum parameters to avoid SDK's internal checksum validation
      // The SDK's checksum middleware converts the body to a ReadableStream for validation,
      // which causes "Received an instance of ReadableStream" errors with Node.js crypto.
      // Since we've already validated checksums, we don't need the SDK to validate them.
      const commandInput = {
        Bucket: bucketName,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: body, // Use Node Readable
        ContentLength: contentLength,
        // Intentionally NOT passing any checksum-related parameters to avoid SDK validation
      };

      const result = yield* Effect.tryPromise({
        try: () => {
          const command = new UploadPartCommand(commandInput);

          // If it's a Node stream, add an error handler to prevent uncaught exceptions
          // from the stream itself, as we handle failures through the send() promise.
          if (body instanceof Readable) {
            body.on("error", (err: unknown) => {
              // Log at debug level for debugging purposes, but don't throw
              // as we handle failures through the send() promise
              Effect.logDebug("Stream error", {
                operation: "uploadPart",
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
          command.middlewareStack.add(
            (next) => (args) => {
              const request = args.request as {
                headers: Record<string, string>;
                duplex?: string;
              };
              request.duplex = "half";
              request.headers["x-amz-content-sha256"] = "UNSIGNED-PAYLOAD";
              if (contentLength !== undefined) {
                request.headers["content-length"] = String(contentLength);
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

          return client.send(command);
        },
        catch: (e) => mapS3Error(e, bucketName, uploadId),
      });

      if (!result.ETag) {
        return yield* Effect.fail(
          new InternalError({
            message: "S3 returned empty ETag for UploadPart",
          }),
        );
      }
      // Return checksums we calculated (since we didn't pass them to SDK to avoid validation issues)
      // The SDK might return some checksums, but we prefer our validated ones
      const s3Result = result as S3ChecksumFields;
      return {
        etag: result.ETag,
        checksumAlgorithm: checksums.algorithm ||
          s3Result.ChecksumAlgorithm as ChecksumAlgorithm,
        checksumType: checksums.type || s3Result.ChecksumType as ChecksumType,
        checksumCRC32: checksums.crc32 || s3Result.ChecksumCRC32,
        checksumCRC32C: checksums.crc32c || s3Result.ChecksumCRC32C,
        checksumCRC64NVME: checksums.crc64nvme || s3Result.ChecksumCRC64NVME,
        checksumSHA1: checksums.sha1 || s3Result.ChecksumSHA1,
        checksumSHA256: checksums.sha256 || s3Result.ChecksumSHA256,
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
  ) =>
    Effect.gen(function* () {
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
        catch: (e) => mapS3Error(e, bucketName, uploadId),
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
      yield* Effect.tryPromise({
        try: () =>
          client.send(
            new AbortMultipartUploadCommand({
              Bucket: bucketName,
              Key: key,
              UploadId: uploadId,
            }),
          ),
        catch: (e) => mapS3Error(e, bucketName, uploadId),
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
        encodingType: result.EncodingType ?? args.encodingType,
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
      } satisfies ListMultipartUploadsResult;
    }),

  listParts: (key: string, uploadId: string) =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: () =>
          client.send(
            new ListPartsCommand({
              Bucket: bucketName,
              Key: key,
              UploadId: uploadId,
            }),
          ),
        catch: (e) => mapS3Error(e, bucketName, uploadId),
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
          ? parseInt(String(result.PartNumberMarker), 10) || 0
          : 0,
        nextPartNumberMarker: result.NextPartNumberMarker
          ? parseInt(String(result.NextPartNumberMarker), 10) || 0
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
      } satisfies ListPartsResult;
    }),
});
