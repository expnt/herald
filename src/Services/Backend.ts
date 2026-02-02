import type { HttpClientError } from "@effect/platform";
import { Context, Data } from "effect";
import type { Effect, Stream } from "effect";

export class NoSuchBucket extends Data.TaggedError("NoSuchBucket")<{
  readonly bucket: string;
  readonly message: string;
}> {}

export class NoSuchKey extends Data.TaggedError("NoSuchKey")<{
  readonly bucket: string;
  readonly key: string;
  readonly message: string;
}> {}

export class BucketAlreadyExists
  extends Data.TaggedError("BucketAlreadyExists")<{
    readonly bucket: string;
    readonly message: string;
  }> {}

export class BucketAlreadyOwnedByYou extends Data.TaggedError(
  "BucketAlreadyOwnedByYou",
)<{
  readonly bucket: string;
  readonly message: string;
}> {}

export class BucketNotEmpty extends Data.TaggedError("BucketNotEmpty")<{
  readonly bucket: string;
  readonly message: string;
}> {}

export class InternalError extends Data.TaggedError("InternalError")<{
  readonly message: string;
}> {}

export class AccessDenied extends Data.TaggedError("AccessDenied")<{
  readonly message: string;
}> {}

export class BadGateway extends Data.TaggedError("BadGateway")<{
  readonly message: string;
}> {}

export class NoSuchUpload extends Data.TaggedError("NoSuchUpload")<{
  readonly uploadId: string;
  readonly message: string;
}> {}

export class InvalidPart extends Data.TaggedError("InvalidPart")<{
  readonly message: string;
}> {}

export class InvalidPartOrder extends Data.TaggedError("InvalidPartOrder")<{
  readonly message: string;
}> {}

export class EntityTooSmall extends Data.TaggedError("EntityTooSmall")<{
  readonly message: string;
}> {}

export class InvalidRequest extends Data.TaggedError("InvalidRequest")<{
  readonly message: string;
}> {}

export class BadDigest extends Data.TaggedError("BadDigest")<{
  readonly message: string;
}> {}

export class InvalidBucketName extends Data.TaggedError("InvalidBucketName")<{
  readonly message: string;
}> {}

export class InvalidArgument extends Data.TaggedError("InvalidArgument")<{
  readonly message: string;
}> {}

export class MalformedXML extends Data.TaggedError("MalformedXML")<{
  readonly message: string;
}> {}

export class MethodNotAllowed extends Data.TaggedError("MethodNotAllowed")<{
  readonly message: string;
}> {}

export class DeleteObjectsError extends Data.TaggedError("DeleteObjectsError")<{
  readonly errors: readonly {
    readonly key: string;
    readonly code: string;
    readonly message: string;
  }[];
}> {}

export type BackendError =
  | NoSuchBucket
  | NoSuchKey
  | BucketAlreadyExists
  | BucketAlreadyOwnedByYou
  | BucketNotEmpty
  | InternalError
  | AccessDenied
  | BadGateway
  | NoSuchUpload
  | InvalidPart
  | InvalidPartOrder
  | EntityTooSmall
  | InvalidRequest
  | BadDigest
  | InvalidBucketName
  | InvalidArgument
  | MalformedXML
  | MethodNotAllowed
  | HttpClientError.HttpClientError
  | DeleteObjectsError;

export interface BucketInfo {
  readonly name: string;
  readonly creationDate: Date;
}

export interface OwnerInfo {
  readonly id: string;
  readonly displayName: string;
}

export interface ListBucketsResult {
  readonly buckets: readonly BucketInfo[];
  readonly owner: OwnerInfo;
}

export interface ObjectInfo {
  readonly key: string;
  readonly lastModified: Date;
  readonly etag: string;
  readonly size: number;
  readonly storageClass?: string;
  readonly owner?: OwnerInfo;
  readonly versionId?: string;
  readonly isLatest?: boolean;
  readonly isDeleteMarker?: boolean;
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
  readonly listType: 1 | 2;
  readonly continuationToken?: string;
  readonly nextContinuationToken?: string;
  readonly keyCount?: number;
  readonly startAfter?: string;
}

export interface ChecksumInfo {
  readonly checksumAlgorithm?: string;
  readonly checksumCRC32?: string;
  readonly checksumCRC32C?: string;
  readonly checksumCRC64NVME?: string;
  readonly checksumSHA1?: string;
  readonly checksumSHA256?: string;
  readonly checksumType?: string;
}

export interface ObjectResponse extends ChecksumInfo {
  readonly stream: Stream.Stream<Uint8Array, Error>;
  readonly nativeStream?: ReadableStream<Uint8Array>;
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly etag?: string;
  readonly lastModified?: Date;
  readonly metadata: Record<string, string>;
  readonly headers: Record<string, string>;
  readonly partsCount?: number;
}

export interface HeadObjectResult extends ChecksumInfo {
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly etag?: string;
  readonly lastModified?: Date;
  readonly metadata: Record<string, string>;
  readonly headers: Record<string, string>;
  readonly partsCount?: number;
}

export interface PutObjectResult extends ChecksumInfo {
  readonly etag?: string;
  readonly versionId?: string;
}

export interface MultipartUploadResult extends ChecksumInfo {
  readonly uploadId: string;
}

export interface UploadPartResult extends ChecksumInfo {
  readonly etag: string;
}

export interface CompleteMultipartUploadResult extends ChecksumInfo {
  readonly location: string;
  readonly bucket: string;
  readonly key: string;
  readonly etag: string;
  readonly versionId?: string;
}

export interface ObjectAttributes {
  readonly etag?: string;
  readonly checksum?: ChecksumInfo;
  readonly objectParts?: {
    readonly totalPartsCount?: number;
    readonly partNumberMarker?: number;
    readonly nextPartNumberMarker?: number;
    readonly maxParts?: number;
    readonly isTruncated?: boolean;
    readonly parts?: readonly PartInfo[];
  };
  readonly objectSize?: number;
  readonly storageClass?: string;
}

export interface PartInfo extends ChecksumInfo {
  readonly partNumber: number;
  readonly lastModified?: Date;
  readonly etag: string;
  readonly size: number;
}

export interface DeleteObjectsResult {
  readonly deleted: readonly string[];
  readonly errors: readonly {
    readonly key: string;
    readonly code: string;
    readonly message: string;
  }[];
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
  readonly keyMarker?: string;
  readonly uploadIdMarker?: string;
  readonly nextKeyMarker?: string;
  readonly nextUploadIdMarker?: string;
  readonly maxUploads: number;
  readonly isTruncated: boolean;
  readonly uploads: readonly MultipartUploadInfo[];
  readonly commonPrefixes: readonly CommonPrefix[];
  readonly prefix?: string;
  readonly delimiter?: string;
  readonly encodingType?: string;
}

export interface ListPartsResult {
  readonly bucket: string;
  readonly key: string;
  readonly uploadId: string;
  readonly partNumberMarker: number;
  readonly nextPartNumberMarker: number;
  readonly maxParts: number;
  readonly isTruncated: boolean;
  readonly parts: readonly PartInfo[];
  readonly initiator: OwnerInfo;
  readonly owner: OwnerInfo;
  readonly storageClass: string;
}

export class Backend extends Context.Tag("Backend")<
  Backend,
  {
    listBuckets: () => Effect.Effect<ListBucketsResult, BackendError>;
    createBucket: (
      name: string,
      headers: Record<string, string | string[] | undefined>,
    ) => Effect.Effect<void, BackendError>;
    deleteBucket: (name: string) => Effect.Effect<void, BackendError>;
    headBucket: (name: string) => Effect.Effect<void, BackendError>;

    listObjects: (args: {
      prefix?: string;
      delimiter?: string;
      marker?: string;
      maxKeys?: number;
      encodingType?: string;
      continuationToken?: string;
      startAfter?: string;
      listType?: 1 | 2;
    }) => Effect.Effect<ListObjectsResult, BackendError>;

    listVersions: (args: {
      prefix?: string;
      delimiter?: string;
      keyMarker?: string;
      versionIdMarker?: string;
      maxKeys?: number;
      encodingType?: string;
    }) => Effect.Effect<ListObjectsResult, BackendError>;

    getObject: (
      key: string,
      headers: Record<string, string | string[] | undefined>,
    ) => Effect.Effect<ObjectResponse, BackendError>;

    headObject: (
      key: string,
      headers: Record<string, string | string[] | undefined>,
    ) => Effect.Effect<HeadObjectResult, BackendError>;

    putObject: (
      key: string,
      stream: Stream.Stream<Uint8Array, Error>,
      headers: Record<string, string | string[] | undefined>,
    ) => Effect.Effect<PutObjectResult, BackendError>;

    deleteObject: (key: string) => Effect.Effect<void, BackendError>;

    deleteObjects: (
      objects: readonly { key: string; versionId?: string }[],
    ) => Effect.Effect<DeleteObjectsResult, BackendError>;

    getObjectAttributes: (
      key: string,
      attributes: readonly string[],
      headers: Record<string, string | string[] | undefined>,
    ) => Effect.Effect<ObjectAttributes, BackendError>;

    copyObject: (
      sourceKey: string,
      destKey: string,
      metadataDirective: "COPY" | "REPLACE",
      headers: Record<string, string | string[] | undefined>,
      sourceBucket?: string,
    ) => Effect.Effect<PutObjectResult, BackendError>;

    // Multipart Upload
    createMultipartUpload: (
      key: string,
      headers: Record<string, string | string[] | undefined>,
    ) => Effect.Effect<MultipartUploadResult, BackendError>;

    uploadPart: (
      key: string,
      uploadId: string,
      partNumber: number,
      body: Stream.Stream<Uint8Array, Error>,
      headers: Record<string, string | string[] | undefined>,
    ) => Effect.Effect<UploadPartResult, BackendError>;

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
    ) => Effect.Effect<CompleteMultipartUploadResult, BackendError>;

    abortMultipartUpload: (
      key: string,
      uploadId: string,
    ) => Effect.Effect<void, BackendError>;

    listMultipartUploads: (args: {
      prefix?: string;
      delimiter?: string;
      keyMarker?: string;
      uploadIdMarker?: string;
      maxUploads?: number;
      encodingType?: string;
    }) => Effect.Effect<ListMultipartUploadsResult, BackendError>;

    listParts: (
      key: string,
      uploadId: string,
    ) => Effect.Effect<ListPartsResult, BackendError>;
  }
>() {}
