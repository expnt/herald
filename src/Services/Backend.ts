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
  | DeleteObjectsError;

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
  ) => Effect.Effect<ObjectResponse, BackendError>;
  readonly headObject: (
    key: string,
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
}

/**
 * Backend service represents a connection to a specific storage backend.
 * It is provided dynamically based on the request context (bucket or backend ID).
 */
export class Backend
  extends Context.Tag("Backend")<Backend, BackendService>() {}
