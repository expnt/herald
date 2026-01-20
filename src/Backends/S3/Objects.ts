import { Chunk, Effect, Option, Stream } from "effect";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsCommand,
  type ListObjectsCommandOutput,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  ListObjectVersionsCommand,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import {
  type CommonPrefix,
  InternalError,
  type ListObjectsResult,
  type ObjectInfo,
  type ObjectResponse,
} from "../../Services/Backend.ts";
import { mapS3Error, type S3Target, stripMinioMetadata } from "./Utils.ts";

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
  ) =>
    Effect.gen(function* () {
      const { client, bucketName } = target;
      const result = yield* Effect.tryPromise({
        try: () =>
          client.send(
            new GetObjectCommand({
              Bucket: bucketName,
              Key: key,
              Range: (headers["range"] || headers["Range"]) as string,
              PartNumber: (headers["part-number"] ||
                  headers["Part-Number"] ||
                  headers["x-amz-part-number"])
                ? parseInt(
                  (headers["part-number"] ||
                    headers["Part-Number"] ||
                    headers["x-amz-part-number"]) as string,
                )
                : undefined,
              IfMatch: (headers["if-match"] || headers["If-Match"]) as string,
              IfNoneMatch: (headers["if-none-match"] ||
                headers["If-None-Match"]) as string,
              IfModifiedSince: (headers["if-modified-since"] ||
                  headers["If-Modified-Since"])
                ? new Date(
                  (headers["if-modified-since"] ||
                    headers["If-Modified-Since"]) as string,
                )
                : undefined,
              IfUnmodifiedSince: (headers["if-unmodified-since"] ||
                  headers["If-Unmodified-Since"])
                ? new Date(
                  (headers["if-unmodified-since"] ||
                    headers["If-Unmodified-Since"]) as string,
                )
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

      const stream = Stream.fromReadableStream(
        getWebStream,
        (e) => new Error(String(e)),
      );

      const metadata: Record<string, string> = {};
      if (result.Metadata) {
        for (const [k, v] of Object.entries(result.Metadata)) {
          metadata[k] = Option.liftThrowable(decodeURIComponent)(
            v ?? "",
          ).pipe(
            Option.getOrElse(() => v ?? ""),
          );
        }
      }

      const s3Headers: Record<string, string> = {};
      if (result.ContentType) {
        s3Headers["content-type"] = result.ContentType;
      }
      if (result.ContentLength !== undefined) {
        s3Headers["content-length"] = String(result.ContentLength);
      }
      if (result.ETag) s3Headers["etag"] = result.ETag;
      if (result.PartsCount !== undefined) {
        s3Headers["x-amz-mp-parts-count"] = String(result.PartsCount);
      }
      if (result.VersionId) {
        s3Headers["x-amz-version-id"] = result.VersionId;
      }
      if (result.LastModified) {
        s3Headers["last-modified"] = result.LastModified.toUTCString();
      }

      for (const [k, v] of Object.entries(metadata)) {
        s3Headers[`x-amz-meta-${k}`] = v;
      }

      return yield* Stream.runCollect(stream).pipe(
        Effect.mapError((e) => new InternalError({ message: String(e) })),
        Effect.map((chunks) => {
          const totalLength = Chunk.reduce(
            chunks,
            0,
            (acc, chunk) => acc + chunk.length,
          );
          const all = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of chunks) {
            all.set(chunk, offset);
            offset += chunk.length;
          }
          return {
            stream: Stream.succeed(all),
            contentType: result.ContentType,
            contentLength: all.length,
            etag: result.ETag,
            lastModified: result.LastModified,
            metadata,
            headers: s3Headers,
          } satisfies ObjectResponse;
        }),
      );
    }),

  headObject: (
    key: string,
    headers: Record<string, string | string[] | undefined>,
  ) =>
    Effect.gen(function* () {
      const { client, bucketName } = target;
      const commandInput = {
        Bucket: bucketName,
        Key: key,
        PartNumber: (headers["part-number"] ||
            headers["Part-Number"] ||
            headers["x-amz-part-number"])
          ? parseInt(
            (headers["part-number"] ||
              headers["Part-Number"] ||
              headers["x-amz-part-number"]) as string,
          )
          : undefined,
      };
      const result = yield* Effect.tryPromise({
        try: () => client.send(new HeadObjectCommand(commandInput)),
        catch: (e) => mapS3Error(e, bucketName),
      });

      const metadata: Record<string, string> = {};
      if (result.Metadata) {
        for (const [k, v] of Object.entries(result.Metadata)) {
          metadata[k] = Option.liftThrowable(decodeURIComponent)(
            v ?? "",
          ).pipe(
            Option.getOrElse(() => v ?? ""),
          );
        }
      }

      const s3Headers: Record<string, string> = {};
      if (result.ContentType) {
        s3Headers["content-type"] = result.ContentType;
      }
      if (result.ContentLength !== undefined) {
        s3Headers["content-length"] = String(result.ContentLength);
      }
      if (result.ETag) s3Headers["etag"] = result.ETag;
      if (result.PartsCount !== undefined) {
        s3Headers["x-amz-mp-parts-count"] = String(result.PartsCount);
      }
      if (result.VersionId) {
        s3Headers["x-amz-version-id"] = result.VersionId;
      }
      if (result.LastModified) {
        s3Headers["last-modified"] = result
          .LastModified.toUTCString();
      }

      for (const [k, v] of Object.entries(metadata)) {
        s3Headers[`x-amz-meta-${k}`] = v;
      }

      return {
        contentType: result.ContentType,
        contentLength: result.ContentLength,
        etag: result.ETag,
        lastModified: result.LastModified,
        metadata,
        headers: s3Headers,
      };
    }),

  putObject: (
    key: string,
    bodyStream: Stream.Stream<Uint8Array, Error>,
    headers: Record<string, string | string[] | undefined>,
  ) =>
    Effect.gen(function* () {
      const { client, bucketName } = target;
      const chunks = yield* Stream.runCollect(bodyStream).pipe(
        Effect.mapError((e) => new InternalError({ message: String(e) })),
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

      const metadata: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase().startsWith("x-amz-meta-")) {
          const metaKey = k.substring("x-amz-meta-".length);
          const value = String(v);
          metadata[metaKey] = /[^\x20-\x7E]/.test(value)
            ? encodeURIComponent(value)
            : value;
        }
      }

      const contentType = headers["content-type"];

      const result = yield* Effect.tryPromise({
        try: () =>
          client.send(
            new PutObjectCommand({
              Bucket: bucketName,
              Key: key,
              Body: body,
              ContentType: contentType ? String(contentType) : undefined,
              Metadata: metadata,
            }),
          ),
        catch: (e) => mapS3Error(e, bucketName),
      });

      return {
        etag: result.ETag,
        versionId: result.VersionId,
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

  createMultipartUpload: (
    key: string,
    headers: Record<string, string | string[] | undefined>,
  ) =>
    Effect.gen(function* () {
      const { client, bucketName } = target;
      const metadata: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase().startsWith("x-amz-meta-")) {
          const metaKey = k.substring("x-amz-meta-".length);
          metadata[metaKey] = String(v);
        }
      }
      const contentType = headers["content-type"];

      const result = yield* Effect.tryPromise({
        try: () =>
          client.send(
            new CreateMultipartUploadCommand({
              Bucket: bucketName,
              Key: key,
              Metadata: metadata,
              ContentType: contentType ? String(contentType) : undefined,
            }),
          ),
        catch: (e) => mapS3Error(e, bucketName),
      });

      if (!result.UploadId) {
        return yield* Effect.fail(
          new InternalError({
            message: "S3 returned empty UploadId",
          }),
        );
      }
      return { uploadId: result.UploadId };
    }),

  uploadPart: (
    key: string,
    uploadId: string,
    partNumber: number,
    bodyStream: Stream.Stream<Uint8Array, Error>,
  ) =>
    Effect.gen(function* () {
      const { client, bucketName } = target;
      const chunks = yield* Stream.runCollect(bodyStream).pipe(
        Effect.mapError((e) => new InternalError({ message: String(e) })),
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

      const result = yield* Effect.tryPromise({
        try: () =>
          client.send(
            new UploadPartCommand({
              Bucket: bucketName,
              Key: key,
              UploadId: uploadId,
              PartNumber: partNumber,
              Body: body,
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
      return { etag: result.ETag };
    }),

  completeMultipartUpload: (
    key: string,
    uploadId: string,
    parts: readonly { etag: string; partNumber: number }[],
  ) =>
    Effect.gen(function* () {
      const { client, bucketName } = target;
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
                })),
              },
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
      return {
        location: result.Location,
        bucket: result.Bucket,
        key: result.Key,
        etag: result.ETag,
        versionId: result.VersionId,
      };
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
        encodingType: result.EncodingType as string,
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
        })),
      };
    }),
});
