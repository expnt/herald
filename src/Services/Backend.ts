import { Context, Schema, type Effect } from "effect"
import type { HttpClientResponse, HttpServerRequest, HttpClientError } from "@effect/platform"

export interface BucketInfo {
    readonly name: string
    readonly creationDate?: Date
}

export interface OwnerInfo {
    readonly id: string
    readonly displayName: string
}

export class NoSuchBucket extends Schema.TaggedError<NoSuchBucket>()("NoSuchBucket", {
    bucketName: Schema.String,
    message: Schema.String
}) { }

export class BucketAlreadyExists extends Schema.TaggedError<BucketAlreadyExists>()("BucketAlreadyExists", {
    bucketName: Schema.String,
    message: Schema.String
}) { }

export class BucketAlreadyOwnedByYou extends Schema.TaggedError<BucketAlreadyOwnedByYou>()("BucketAlreadyOwnedByYou", {
    bucketName: Schema.String,
    message: Schema.String
}) { }

export class InternalError extends Schema.TaggedError<InternalError>()("InternalError", {
    message: Schema.String
}) { }

export class AccessDenied extends Schema.TaggedError<AccessDenied>()("AccessDenied", {
    message: Schema.String
}) { }

export class NoSuchKey extends Schema.TaggedError<NoSuchKey>()("NoSuchKey", {
    bucketName: Schema.String,
    key: Schema.String,
    message: Schema.String
}) { }

export type BackendError = NoSuchBucket | BucketAlreadyExists | BucketAlreadyOwnedByYou | InternalError | AccessDenied | NoSuchKey

export interface BackendService {
    readonly listBuckets: () => Effect.Effect<{ buckets: readonly BucketInfo[], owner: OwnerInfo }, BackendError>
    readonly createBucket: () => Effect.Effect<void, BackendError>
    readonly deleteBucket: () => Effect.Effect<void, BackendError>
    readonly headBucket: () => Effect.Effect<void, BackendError>
    readonly proxy: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError | BackendError, never>
}

/**
 * Backend service represents a connection to a specific storage backend.
 * It is provided dynamically based on the request context (bucket or backend ID).
 */
export class Backend extends Context.Tag("Backend")<Backend, BackendService>() { }
