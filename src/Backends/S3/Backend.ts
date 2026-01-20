import { Chunk, Effect, Option, Stream } from "effect";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  type ListBucketsCommandOutput,
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
import type { MaterializedBucket } from "../../Domain/Config.ts";
import { AppConfig } from "../../Config/Layer.ts";
import {
  AccessDenied,
  type BackendError,
  type BackendService,
  BucketAlreadyExists,
  BucketAlreadyOwnedByYou,
  type BucketInfo,
  BucketNotEmpty,
  type CommonPrefix,
  type DeleteObjectsResult,
  EntityTooSmall,
  InternalError,
  InvalidPart,
  InvalidPartOrder,
  InvalidRequest,
  type ListObjectsResult,
  MalformedXML,
  NoSuchBucket,
  NoSuchKey,
  NoSuchUpload,
  type ObjectInfo,
} from "../../Services/Backend.ts";
import { S3Client } from "./Client.ts";

/**
 * Strips MinIO metadata suffixes like [minio_cache:v2,return:] from strings.
 */
function stripMinioMetadata(s: string): string {
  return s.replace(/\[minio_cache:[^\]]+\]/g, "");
}

/**
 * Maps S3 SDK exceptions to internal BackendError types.
 */
function mapS3Error(e: unknown, bucketName?: string): BackendError {
  const err = e as {
    name?: string;
    Code?: string;
    Message?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const name = err?.name || err?.Code ||
    (e instanceof Error ? e.name : "UnknownError");
  const message = err?.message || err?.Message ||
    "An unknown S3 error occurred";
  const bucket = bucketName ?? "unknown-bucket";

  switch (name) {
    case "NoSuchBucket":
    case "NotFound":
      return new NoSuchBucket({ bucketName: bucket, message });
    case "NoSuchKey":
      return new NoSuchKey({
        bucketName: bucket,
        key: "unknown",
        message: message,
      });
    case "NoSuchUpload":
      return new NoSuchUpload({
        uploadId: "unknown",
        message: message,
      });
    case "InvalidPart":
    case "InvalidPartNumber":
      return new InvalidPart({ message });
    case "InvalidPartOrder":
      return new InvalidPartOrder({ message });
    case "EntityTooSmall":
      return new EntityTooSmall({ message });
    case "InvalidRequest":
      if (message.includes("at least one part")) {
        return new MalformedXML({ message });
      }
      return new InvalidRequest({ message });
    case "MalformedXML":
      return new MalformedXML({ message });
    case "BucketAlreadyExists":
      return new BucketAlreadyExists({ bucketName: bucket, message });
    case "BucketAlreadyOwnedByYou":
      return new BucketAlreadyOwnedByYou({ bucketName: bucket, message });
    case "AccessDenied":
    case "Forbidden":
      return new AccessDenied({ message });
    case "BucketNotEmpty":
    case "Conflict":
      return new BucketNotEmpty({ bucketName: bucket, message });
  }

  // Handle case where it might be a raw 404 from HEAD request
  if (err?.$metadata?.httpStatusCode === 404) {
    return new NoSuchKey({
      bucketName: bucket,
      key: "unknown",
      message: "Not Found",
    });
  }

  return new InternalError({
    message: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
  });
}

/**
 * Creates an S3-specific Backend implementation for a given configuration context.
 */
export const makeS3Backend = (
  bucket: MaterializedBucket | { backend_id: string },
): Effect.Effect<BackendService, never, S3Client | AppConfig> =>
  Effect.all({
    s3Service: S3Client,
    config: AppConfig,
  }).pipe(
    Effect.map(({ s3Service, config }) => {
      const getTargetBucket = (): MaterializedBucket => {
        if ("bucket_name" in bucket) return bucket as MaterializedBucket;

        const backendConfig = config.raw.backends[bucket.backend_id];
        if (backendConfig && backendConfig.protocol === "s3") {
          return {
            name: "",
            backend_id: bucket.backend_id,
            protocol: "s3" as const,
            endpoint: backendConfig.endpoint,
            region: backendConfig.region,
            bucket_name: "",
            credentials: backendConfig.credentials,
          };
        }
        throw new Error(`Backend ${bucket.backend_id} is not an S3 backend`);
      };

      const targetBucket = getTargetBucket();

      const service: BackendService = {
        listBuckets: () =>
          s3Service.getClient(targetBucket).pipe(
            Effect.mapError((e) => mapS3Error(e, targetBucket.name)),
            Effect.flatMap((client) =>
              Effect.tryPromise({
                try: () =>
                  client.send(new ListBucketsCommand({})) as Promise<
                    ListBucketsCommandOutput
                  >,
                catch: (e) => mapS3Error(e, targetBucket.name),
              })
            ),
            Effect.flatMap((result) => {
              const buckets: BucketInfo[] = [];
              for (const b of (result.Buckets ?? [])) {
                if (b.Name === undefined) {
                  return Effect.fail(
                    new InternalError({
                      message: "S3 returned bucket without Name",
                    }),
                  );
                }
                buckets.push({
                  name: b.Name,
                  creationDate: b.CreationDate,
                });
              }

              return Effect.succeed({
                buckets,
                owner: {
                  id: result.Owner?.ID ?? "unknown-owner-id",
                  displayName: result.Owner?.DisplayName ??
                    "unknown-owner-name",
                },
              });
            }),
          ),

        createBucket: () =>
          s3Service.getClient(targetBucket).pipe(
            Effect.mapError((e) => mapS3Error(e, targetBucket.name)),
            Effect.flatMap((client) =>
              Effect.tryPromise({
                try: () =>
                  client.send(
                    new CreateBucketCommand({
                      Bucket: targetBucket.bucket_name,
                    }),
                  ),
                catch: (e) => mapS3Error(e, targetBucket.bucket_name),
              })
            ),
            Effect.map(() => undefined),
          ),

        deleteBucket: () =>
          s3Service.getClient(targetBucket).pipe(
            Effect.mapError((e) => mapS3Error(e, targetBucket.name)),
            Effect.flatMap((client) =>
              Effect.tryPromise({
                try: () =>
                  client.send(
                    new DeleteBucketCommand({
                      Bucket: targetBucket.bucket_name,
                    }),
                  ),
                catch: (e) => mapS3Error(e, targetBucket.bucket_name),
              })
            ),
            Effect.map(() => undefined),
          ),

        headBucket: () =>
          s3Service.getClient(targetBucket).pipe(
            Effect.mapError((e) => mapS3Error(e, targetBucket.name)),
            Effect.flatMap((client) =>
              Effect.tryPromise({
                try: () =>
                  client.send(
                    new HeadBucketCommand({ Bucket: targetBucket.bucket_name }),
                  ),
                catch: (e) => mapS3Error(e, targetBucket.bucket_name),
              })
            ),
            Effect.map(() => undefined),
          ),

        listObjects: (args) =>
          s3Service.getClient(targetBucket).pipe(
            Effect.mapError((e) => mapS3Error(e, targetBucket.name)),
            Effect.flatMap((client) => {
              if (args.listType === 2) {
                return Effect.tryPromise({
                  try: () =>
                    client.send(
                      new ListObjectsV2Command({
                        Bucket: targetBucket.bucket_name,
                        Prefix: args.prefix,
                        Delimiter: args.delimiter,
                        MaxKeys: args.maxKeys,
                        ContinuationToken: args.continuationToken,
                        StartAfter: args.startAfter,
                      }),
                    ) as Promise<ListObjectsV2CommandOutput>,
                  catch: (e) => mapS3Error(e, targetBucket.bucket_name),
                }).pipe(
                  Effect.map((result): ListObjectsResult => ({
                    name: result.Name ?? targetBucket.bucket_name,
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
                  })),
                );
              } else {
                return Effect.tryPromise({
                  try: () =>
                    client.send(
                      new ListObjectsCommand({
                        Bucket: targetBucket.bucket_name,
                        Prefix: args.prefix,
                        Delimiter: args.delimiter,
                        Marker: args.marker,
                        MaxKeys: args.maxKeys,
                      }),
                    ) as Promise<ListObjectsCommandOutput>,
                  catch: (e) => mapS3Error(e, targetBucket.bucket_name),
                }).pipe(
                  Effect.map((result): ListObjectsResult => ({
                    name: result.Name ?? targetBucket.bucket_name,
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
                  })),
                );
              }
            }),
          ),

        listVersions: (args) =>
          s3Service.getClient(targetBucket).pipe(
            Effect.mapError((e) => mapS3Error(e, targetBucket.name)),
            Effect.flatMap((client) =>
              Effect.tryPromise({
                try: () =>
                  client.send(
                    new ListObjectVersionsCommand({
                      Bucket: targetBucket.bucket_name,
                      Prefix: args.prefix,
                      Delimiter: args.delimiter,
                      KeyMarker: args.keyMarker,
                      VersionIdMarker: args.versionIdMarker,
                      MaxKeys: args.maxKeys,
                    }),
                  ),
                catch: (e) => mapS3Error(e, targetBucket.bucket_name),
              })
            ),
            Effect.map((result): ListObjectsResult => ({
              name: result.Name ?? targetBucket.bucket_name,
              prefix: result.Prefix,
              marker: result.KeyMarker,
              nextMarker: result.NextKeyMarker,
              maxKeys: result.MaxKeys ?? 1000,
              delimiter: result.Delimiter,
              isTruncated: result.IsTruncated ?? false,
              encodingType: args.encodingType,
              listType: 1, // listVersions is similar to V1
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
            })),
          ),

        getObject: (key, headers) =>
          s3Service.getClient(targetBucket).pipe(
            Effect.mapError((e) => mapS3Error(e, targetBucket.name)),
            Effect.flatMap((client) =>
              Effect.tryPromise({
                try: () =>
                  client.send(
                    new GetObjectCommand({
                      Bucket: targetBucket.bucket_name,
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
                      IfMatch:
                        (headers["if-match"] || headers["If-Match"]) as string,
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
                catch: (e) => mapS3Error(e, targetBucket.bucket_name),
              })
            ),
            Effect.flatMap((result) => {
              const body = result.Body;
              if (!body) {
                return Effect.fail(
                  new InternalError({
                    message: "S3 returned empty body for GetObject",
                  }),
                );
              }

              // AWS SDK Body can be many things. In Deno/Browser it has transformToWebStream()
              // Use a type-safe check to avoid 'any'
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

              const headers: Record<string, string> = {};
              if (result.ContentType) {
                headers["content-type"] = result.ContentType;
              }
              if (result.ContentLength !== undefined) {
                headers["content-length"] = String(result.ContentLength);
              }
              if (result.ETag) headers["etag"] = result.ETag;
              if (result.PartsCount !== undefined) {
                headers["x-amz-mp-parts-count"] = String(result.PartsCount);
              }
              if (result.VersionId) {
                headers["x-amz-version-id"] = result.VersionId;
              }
              if (result.LastModified) {
                headers["last-modified"] = result.LastModified.toUTCString();
              }

              for (const [k, v] of Object.entries(metadata)) {
                headers[`x-amz-meta-${k}`] = v;
              }

              // Buffer the entire stream to ensure it's fully read and connection is closed
              // This also addresses issues where the SDK's Body might not be a standard ReadableStream
              return Stream.runCollect(stream).pipe(
                Effect.mapError((e) =>
                  new InternalError({ message: String(e) })
                ),
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
                    headers,
                  };
                }),
              );
            }),
          ),

        headObject: (key, headers) =>
          s3Service.getClient(targetBucket).pipe(
            Effect.mapError((e) => mapS3Error(e, targetBucket.name)),
            Effect.flatMap((client) => {
              const commandInput = {
                Bucket: targetBucket.bucket_name,
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
              return Effect.tryPromise({
                try: () => client.send(new HeadObjectCommand(commandInput)),
                catch: (e) => mapS3Error(e, targetBucket.bucket_name),
              });
            }),
            Effect.map((result) => {
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

              const headers: Record<string, string> = {};
              if (result.ContentType) {
                headers["content-type"] = result.ContentType;
              }
              if (result.ContentLength !== undefined) {
                headers["content-length"] = String(result.ContentLength);
              }
              if (result.ETag) headers["etag"] = result.ETag;
              if (result.PartsCount !== undefined) {
                headers["x-amz-mp-parts-count"] = String(result.PartsCount);
              }
              if (result.VersionId) {
                headers["x-amz-version-id"] = result.VersionId;
              }
              if (result.LastModified) {
                headers["last-modified"] = result
                  .LastModified.toUTCString();
              }

              for (const [k, v] of Object.entries(metadata)) {
                headers[`x-amz-meta-${k}`] = v;
              }

              return {
                contentType: result.ContentType,
                contentLength: result.ContentLength,
                etag: result.ETag,
                lastModified: result.LastModified,
                metadata,
                headers,
              };
            }),
          ),

        putObject: (key, bodyStream, headers) =>
          s3Service.getClient(targetBucket).pipe(
            Effect.mapError((e) => mapS3Error(e, targetBucket.name)),
            Effect.flatMap((client) =>
              Stream.runCollect(bodyStream).pipe(
                Effect.mapError((e) =>
                  new InternalError({ message: String(e) })
                ),
                Effect.flatMap((chunks) => {
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

                  return Effect.tryPromise({
                    try: () =>
                      client.send(
                        new PutObjectCommand({
                          Bucket: targetBucket.bucket_name,
                          Key: key,
                          Body: body,
                          ContentType: contentType
                            ? String(contentType)
                            : undefined,
                          Metadata: metadata,
                        }),
                      ),
                    catch: (e) => mapS3Error(e, targetBucket.bucket_name),
                  });
                }),
              )
            ),
            Effect.map((result) => ({
              etag: result.ETag,
              versionId: result.VersionId,
            })),
          ),

        deleteObject: (key) =>
          s3Service.getClient(targetBucket).pipe(
            Effect.mapError((e) => mapS3Error(e, targetBucket.name)),
            Effect.flatMap((client) =>
              Effect.tryPromise({
                try: () =>
                  client.send(
                    new DeleteObjectCommand({
                      Bucket: targetBucket.bucket_name,
                      Key: key,
                    }),
                  ),
                catch: (e) => mapS3Error(e, targetBucket.bucket_name),
              })
            ),
            Effect.map(() => undefined),
          ),

        deleteObjects: (
          objects,
        ): Effect.Effect<DeleteObjectsResult, BackendError> =>
          s3Service.getClient(targetBucket).pipe(
            Effect.mapError((e) => mapS3Error(e, targetBucket.name)),
            Effect.flatMap((client) =>
              Effect.tryPromise({
                try: () =>
                  client.send(
                    new DeleteObjectsCommand({
                      Bucket: targetBucket.bucket_name,
                      Delete: {
                        Objects: objects.map((o) => ({
                          Key: o.key,
                          VersionId: o.versionId === "null"
                            ? undefined
                            : o.versionId,
                        })),
                      },
                    }),
                  ),
                catch: (e) => mapS3Error(e, targetBucket.bucket_name),
              })
            ),
            Effect.map((result) => ({
              deleted: (result.Deleted ?? []).map((d) => d.Key ?? ""),
              errors: (result.Errors ?? []).map((e) => ({
                key: e.Key ?? "unknown",
                code: e.Code ?? "InternalError",
                message: e.Message ?? "Unknown error",
              })),
            })),
          ),

        createMultipartUpload: (key, headers) =>
          s3Service.getClient(targetBucket).pipe(
            Effect.mapError((e) => mapS3Error(e, targetBucket.name)),
            Effect.flatMap((client) => {
              const metadata: Record<string, string> = {};
              for (const [k, v] of Object.entries(headers)) {
                if (k.toLowerCase().startsWith("x-amz-meta-")) {
                  const metaKey = k.substring("x-amz-meta-".length);
                  metadata[metaKey] = String(v);
                }
              }
              const contentType = headers["content-type"];

              return Effect.tryPromise({
                try: () =>
                  client.send(
                    new CreateMultipartUploadCommand({
                      Bucket: targetBucket.bucket_name,
                      Key: key,
                      Metadata: metadata,
                      ContentType: contentType
                        ? String(contentType)
                        : undefined,
                    }),
                  ),
                catch: (e) => mapS3Error(e, targetBucket.bucket_name),
              });
            }),
            Effect.flatMap((result) => {
              if (!result.UploadId) {
                return Effect.fail(
                  new InternalError({
                    message: "S3 returned empty UploadId",
                  }),
                );
              }
              return Effect.succeed({ uploadId: result.UploadId });
            }),
          ),

        uploadPart: (key, uploadId, partNumber, bodyStream) =>
          s3Service.getClient(targetBucket).pipe(
            Effect.mapError((e) => mapS3Error(e, targetBucket.name)),
            Effect.flatMap((client) =>
              Stream.runCollect(bodyStream).pipe(
                Effect.mapError((e) =>
                  new InternalError({ message: String(e) })
                ),
                Effect.flatMap((chunks) => {
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

                  return Effect.tryPromise({
                    try: () =>
                      client.send(
                        new UploadPartCommand({
                          Bucket: targetBucket.bucket_name,
                          Key: key,
                          UploadId: uploadId,
                          PartNumber: partNumber,
                          Body: body,
                        }),
                      ),
                    catch: (e) => mapS3Error(e, targetBucket.bucket_name),
                  });
                }),
              )
            ),
            Effect.flatMap((result) => {
              if (!result.ETag) {
                return Effect.fail(
                  new InternalError({
                    message: "S3 returned empty ETag for UploadPart",
                  }),
                );
              }
              return Effect.succeed({ etag: result.ETag });
            }),
          ),

        completeMultipartUpload: (key, uploadId, parts) =>
          s3Service.getClient(targetBucket).pipe(
            Effect.mapError((e) => mapS3Error(e, targetBucket.name)),
            Effect.flatMap((client) =>
              Effect.tryPromise({
                try: () =>
                  client.send(
                    new CompleteMultipartUploadCommand({
                      Bucket: targetBucket.bucket_name,
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
                catch: (e) => mapS3Error(e, targetBucket.bucket_name),
              })
            ),
            Effect.flatMap((result) => {
              if (
                !result.Location || !result.Bucket || !result.Key ||
                !result.ETag
              ) {
                return Effect.fail(
                  new InternalError({
                    message:
                      "S3 returned incomplete CompleteMultipartUploadResult",
                  }),
                );
              }
              return Effect.succeed({
                location: result.Location,
                bucket: result.Bucket,
                key: result.Key,
                etag: result.ETag,
                versionId: result.VersionId,
              });
            }),
          ),

        abortMultipartUpload: (key, uploadId) =>
          s3Service.getClient(targetBucket).pipe(
            Effect.mapError((e) => mapS3Error(e, targetBucket.name)),
            Effect.flatMap((client) =>
              Effect.tryPromise({
                try: () =>
                  client.send(
                    new AbortMultipartUploadCommand({
                      Bucket: targetBucket.bucket_name,
                      Key: key,
                      UploadId: uploadId,
                    }),
                  ),
                catch: (e) => mapS3Error(e, targetBucket.bucket_name),
              })
            ),
            Effect.map(() => undefined),
          ),

        listMultipartUploads: (args) =>
          s3Service.getClient(targetBucket).pipe(
            Effect.mapError((e) => mapS3Error(e, targetBucket.name)),
            Effect.flatMap((client) =>
              Effect.tryPromise({
                try: () =>
                  client.send(
                    new ListMultipartUploadsCommand({
                      Bucket: targetBucket.bucket_name,
                      Prefix: args.prefix,
                      Delimiter: args.delimiter,
                      KeyMarker: args.keyMarker,
                      UploadIdMarker: args.uploadIdMarker,
                      MaxUploads: args.maxUploads,
                      EncodingType: args.encodingType as "url" | undefined,
                    }),
                  ),
                catch: (e) => mapS3Error(e, targetBucket.bucket_name),
              })
            ),
            Effect.map((result) => ({
              bucket: result.Bucket ?? targetBucket.bucket_name,
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
            })),
          ),

        listParts: (key, uploadId) =>
          s3Service.getClient(targetBucket).pipe(
            Effect.mapError((e) => mapS3Error(e, targetBucket.name)),
            Effect.flatMap((client) =>
              Effect.tryPromise({
                try: () =>
                  client.send(
                    new ListPartsCommand({
                      Bucket: targetBucket.bucket_name,
                      Key: key,
                      UploadId: uploadId,
                    }),
                  ),
                catch: (e) => mapS3Error(e, targetBucket.bucket_name),
              })
            ),
            Effect.map((result) => ({
              bucket: result.Bucket ?? targetBucket.bucket_name,
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
            })),
          ),
      };

      return service;
    }),
  );
