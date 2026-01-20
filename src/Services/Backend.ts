/**
 * The `Backend` service represents a single impl that herald can proxy to.
 */

import { Context, type Effect, Schema, type Stream } from "effect";

export interface BucketInfo {
  readonly name: string;
  readonly creationDate?: Date;
}

export interface OwnerInfo {
  readonly id: string;
  readonly displayName: string;
}

export interface ObjectInfo {
  readonly key: string;
  readonly lastModified: Date;
  readonly etag: string;
  readonly size: number;
  readonly storageClass?: string;
  readonly owner?: OwnerInfo;
  readonly versionId?: string;
  readonly isDeleteMarker?: boolean;
  readonly isLatest?: boolean;
}

export interface CommonPrefix {
  readonly prefix: string;
}

export interface ListObjectsResult {
  readonly name: string;
  readonly prefix?: string;
  readonly marker?: string;
  readonly nextMarker?: string;
  readonly maxKeys: number;
  readonly delimiter?: string;
  readonly isTruncated: boolean;
  readonly contents: readonly ObjectInfo[];
  readonly commonPrefixes: readonly CommonPrefix[];
  readonly encodingType?: string;
  readonly continuationToken?: string;
  readonly nextContinuationToken?: string;
  readonly startAfter?: string;
  readonly keyCount?: number;
  readonly listType: 1 | 2;
}

export interface ObjectResponse {
  readonly stream: Stream.Stream<Uint8Array, Error>;
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly etag?: string;
  readonly lastModified?: Date;
  readonly metadata: Record<string, string>;
  readonly headers: Record<string, string>;
}

export interface HeadObjectResult {
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly etag?: string;
  readonly lastModified?: Date;
  readonly metadata: Record<string, string>;
  readonly headers: Record<string, string>;
}

export interface PutObjectResult {
  readonly etag?: string;
  readonly versionId?: string;
}

export interface MultipartUploadResult {
  readonly uploadId: string;
}

export interface UploadPartResult {
  readonly etag: string;
}

export interface CompleteMultipartUploadResult {
  readonly location: string;
  readonly bucket: string;
  readonly key: string;
  readonly etag: string;
  readonly versionId?: string;
}

export interface PartInfo {
  readonly partNumber: number;
  readonly lastModified: Date;
  readonly etag: string;
  readonly size: number;
}

export interface ListPartsResult {
  readonly bucket: string;
  readonly key: string;
  readonly uploadId: string;
  readonly owner: OwnerInfo;
  readonly initiator: OwnerInfo;
  readonly storageClass: string;
  readonly partNumberMarker: number;
  readonly nextPartNumberMarker: number;
  readonly maxParts: number;
  readonly isTruncated: boolean;
  readonly parts: readonly PartInfo[];
}

export interface MultipartUploadInfo {
  readonly key: string;
  readonly uploadId: string;
  readonly owner: OwnerInfo;
  readonly initiator: OwnerInfo;
  readonly storageClass: string;
  readonly initiated: Date;
}

export interface ListMultipartUploadsResult {
  readonly bucket: string;
  readonly prefix?: string;
  readonly keyMarker?: string;
  readonly uploadIdMarker?: string;
  readonly nextKeyMarker?: string;
  readonly nextUploadIdMarker?: string;
  readonly maxUploads: number;
  readonly delimiter?: string;
  readonly isTruncated: boolean;
  readonly uploads: readonly MultipartUploadInfo[];
  readonly commonPrefixes: readonly CommonPrefix[];
  readonly encodingType?: string;
}

export class NoSuchBucket
  extends Schema.TaggedError<NoSuchBucket>()("NoSuchBucket", {
    bucketName: Schema.String,
    message: Schema.String,
  }) {}

export class BucketAlreadyExists
  extends Schema.TaggedError<BucketAlreadyExists>()("BucketAlreadyExists", {
    bucketName: Schema.String,
    message: Schema.String,
  }) {}

export class BucketAlreadyOwnedByYou
  extends Schema.TaggedError<BucketAlreadyOwnedByYou>()(
    "BucketAlreadyOwnedByYou",
    {
      bucketName: Schema.String,
      message: Schema.String,
    },
  ) {}

export class InternalError
  extends Schema.TaggedError<InternalError>()("InternalError", {
    message: Schema.String,
  }) {}

export class AccessDenied
  extends Schema.TaggedError<AccessDenied>()("AccessDenied", {
    message: Schema.String,
  }) {}

export class NoSuchKey extends Schema.TaggedError<NoSuchKey>()("NoSuchKey", {
  bucketName: Schema.String,
  key: Schema.String,
  message: Schema.String,
}) {}

export class BucketNotEmpty
  extends Schema.TaggedError<BucketNotEmpty>()("BucketNotEmpty", {
    bucketName: Schema.String,
    message: Schema.String,
  }) {}

export class NoSuchUpload
  extends Schema.TaggedError<NoSuchUpload>()("NoSuchUpload", {
    uploadId: Schema.String,
    message: Schema.String,
  }) {}

export class InvalidPart
  extends Schema.TaggedError<InvalidPart>()("InvalidPart", {
    message: Schema.String,
  }) {}

export class InvalidPartOrder
  extends Schema.TaggedError<InvalidPartOrder>()("InvalidPartOrder", {
    message: Schema.String,
  }) {}

export class EntityTooSmall
  extends Schema.TaggedError<EntityTooSmall>()("EntityTooSmall", {
    message: Schema.String,
  }) {}

export class InvalidRequest
  extends Schema.TaggedError<InvalidRequest>()("InvalidRequest", {
    message: Schema.String,
  }) {}

export class MalformedXML
  extends Schema.TaggedError<MalformedXML>()("MalformedXML", {
    message: Schema.String,
  }) {}

export interface DeleteError {
  readonly key: string;
  readonly code: string;
  readonly message: string;
}

export interface DeleteObjectsResult {
  readonly deleted: readonly string[];
  readonly errors: readonly DeleteError[];
}

export class DeleteObjectsError
  extends Schema.TaggedError<DeleteObjectsError>()("DeleteObjectsError", {
    message: Schema.String,
    deleted: Schema.Array(Schema.String),
    errors: Schema.Array(Schema.Struct({
      key: Schema.String,
      code: Schema.String,
      message: Schema.String,
    })),
  }) {}

export type BackendError =
  | NoSuchBucket
  | BucketAlreadyExists
  | BucketAlreadyOwnedByYou
  | InternalError
  | AccessDenied
  | NoSuchKey
  | BucketNotEmpty
  | DeleteObjectsError
  | NoSuchUpload
  | InvalidPart
  | InvalidPartOrder
  | EntityTooSmall
  | InvalidRequest
  | MalformedXML;

export interface BackendService {
  readonly listBuckets: () => Effect.Effect<
    { buckets: readonly BucketInfo[]; owner: OwnerInfo },
    BackendError
  >;
  readonly createBucket: () => Effect.Effect<void, BackendError>;
  readonly deleteBucket: () => Effect.Effect<void, BackendError>;
  readonly headBucket: () => Effect.Effect<void, BackendError>;
  readonly listObjects: (args: {
    prefix?: string;
    delimiter?: string;
    marker?: string;
    maxKeys?: number;
    encodingType?: string;
    continuationToken?: string;
    startAfter?: string;
    listType?: 1 | 2;
  }) => Effect.Effect<ListObjectsResult, BackendError>;
  readonly listVersions: (args: {
    prefix?: string;
    delimiter?: string;
    keyMarker?: string;
    versionIdMarker?: string;
    maxKeys?: number;
    encodingType?: string;
  }) => Effect.Effect<ListObjectsResult, BackendError>;
  readonly getObject: (
    key: string,
    headers: Record<string, string | string[] | undefined>,
  ) => Effect.Effect<ObjectResponse, BackendError>;
  readonly headObject: (
    key: string,
    headers: Record<string, string | string[] | undefined>,
  ) => Effect.Effect<HeadObjectResult, BackendError>;
  readonly putObject: (
    key: string,
    body: Stream.Stream<Uint8Array, Error>,
    headers: Record<string, string | string[] | undefined>,
  ) => Effect.Effect<PutObjectResult, BackendError>;
  readonly deleteObject: (key: string) => Effect.Effect<void, BackendError>;
  readonly deleteObjects: (
    objects: readonly { key: string; versionId?: string }[],
  ) => Effect.Effect<DeleteObjectsResult, BackendError>;

  // Multipart Upload
  readonly createMultipartUpload: (
    key: string,
    headers: Record<string, string | string[] | undefined>,
  ) => Effect.Effect<MultipartUploadResult, BackendError>;
  readonly uploadPart: (
    key: string,
    uploadId: string,
    partNumber: number,
    body: Stream.Stream<Uint8Array, Error>,
  ) => Effect.Effect<UploadPartResult, BackendError>;
  readonly completeMultipartUpload: (
    key: string,
    uploadId: string,
    parts: readonly { etag: string; partNumber: number }[],
  ) => Effect.Effect<CompleteMultipartUploadResult, BackendError>;
  readonly abortMultipartUpload: (
    key: string,
    uploadId: string,
  ) => Effect.Effect<void, BackendError>;
  readonly listMultipartUploads: (args: {
    prefix?: string;
    delimiter?: string;
    keyMarker?: string;
    uploadIdMarker?: string;
    maxUploads?: number;
    encodingType?: string;
  }) => Effect.Effect<ListMultipartUploadsResult, BackendError>;
  readonly listParts: (
    key: string,
    uploadId: string,
  ) => Effect.Effect<ListPartsResult, BackendError>;
}

/**
 * Backend service represents a connection to a specific storage backend.
 * It is provided dynamically based on the request context (bucket or backend ID).
 */
export class Backend
  extends Context.Tag("Backend")<Backend, BackendService>() {}
