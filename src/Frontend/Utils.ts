import { Effect, Option } from "effect"
import { BackendResolver } from "../Services/BackendResolver.ts"
import { S3Xml } from "../Services/S3Xml.ts"
import { Backend, NoSuchBucket, NoSuchKey, BucketAlreadyExists, BucketAlreadyOwnedByYou, InternalError, AccessDenied } from "../Services/Backend.ts"
import { HttpServerRequest, type HttpServerResponse } from "@effect/platform"
import type { AppConfig } from "../Config/Layer.ts"
import type { S3Client } from "../Backends/S3/Client.ts"
import { BadGateway } from "./Api.ts"

/**
 * Resolves a bucket by name and runs the provided effect with the resolved backend.
 * Centralizes error handling via S3Xml.formatError.
 */
export function resolveBucket<A extends HttpServerResponse.HttpServerResponse, E, R>(
  bucketName: string,
  fn: (backend: typeof Backend.Service) => Effect.Effect<A, E, R | Backend>
): Effect.Effect<HttpServerResponse.HttpServerResponse, BadGateway, R | BackendResolver | S3Xml | AppConfig | S3Client | HttpServerRequest.HttpServerRequest> {
  return Effect.gen(function* () {
    const resolver = yield* BackendResolver
    const s3Xml = yield* S3Xml
    const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)
    const isHead = Option.isSome(request) ? request.value.method === "HEAD" : false

    const program = Effect.gen(function* () {
      const backend = yield* Backend
      return yield* fn(backend)
    })

    return yield* resolver.provideForBucket(bucketName, program).pipe(
      Effect.catchAll((e) => {
        if (
          e instanceof NoSuchBucket ||
          e instanceof NoSuchKey ||
          e instanceof BucketAlreadyExists ||
          e instanceof BucketAlreadyOwnedByYou ||
          e instanceof InternalError ||
          e instanceof AccessDenied
        ) {
          return Effect.succeed(s3Xml.formatError(e, isHead))
        }
        return Effect.fail(new BadGateway({ message: e instanceof Error ? e.message : String(e) }))
      })
    )
  })
}

/**
 * Resolves a backend by ID and runs the provided effect with the resolved backend.
 * Centralizes error handling via S3Xml.formatError.
 */
export function resolveBackend<A extends HttpServerResponse.HttpServerResponse, E, R>(
  backendId: string,
  fn: (backend: typeof Backend.Service) => Effect.Effect<A, E, R | Backend>
): Effect.Effect<HttpServerResponse.HttpServerResponse, BadGateway, R | BackendResolver | S3Xml | AppConfig | S3Client | HttpServerRequest.HttpServerRequest> {
  return Effect.gen(function* () {
    const resolver = yield* BackendResolver
    const s3Xml = yield* S3Xml
    const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)
    const isHead = Option.isSome(request) ? request.value.method === "HEAD" : false

    const program = Effect.gen(function* () {
      const backend = yield* Backend
      return yield* fn(backend)
    })

    return yield* resolver.provideForBackendId(backendId, program).pipe(
      Effect.catchAll((e) => {
        if (
          e instanceof NoSuchBucket ||
          e instanceof NoSuchKey ||
          e instanceof BucketAlreadyExists ||
          e instanceof BucketAlreadyOwnedByYou ||
          e instanceof InternalError ||
          e instanceof AccessDenied
        ) {
          return Effect.succeed(s3Xml.formatError(e, isHead))
        }
        return Effect.fail(new BadGateway({ message: String(e) }))
      })
    )
  })
}
