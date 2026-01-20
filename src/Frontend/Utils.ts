import { Effect, Option } from "effect";
import { BackendResolver } from "../Services/BackendResolver.ts";
import { S3Xml } from "../Services/S3Xml.ts";
import {
  AccessDenied,
  Backend,
  BucketAlreadyExists,
  BucketAlreadyOwnedByYou,
  BucketNotEmpty,
  DeleteObjectsError,
  EntityTooSmall,
  InternalError,
  InvalidPart,
  InvalidPartOrder,
  InvalidRequest,
  MalformedXML,
  NoSuchBucket,
  NoSuchKey,
  NoSuchUpload,
} from "../Services/Backend.ts";
import { HttpServerRequest, type HttpServerResponse } from "@effect/platform";
import type { AppConfig } from "../Config/Layer.ts";
import type { S3Client } from "../Backends/S3/Client.ts";
import type { SwiftClient } from "../Backends/Swift/Client.ts";
import { BadGateway } from "./Api.ts";

/**
 * Fixes header values that might have been incorrectly decoded as Latin-1
 * instead of UTF-8 by the HTTP server.
 */
export function fixHeaderEncoding(value: string): string {
  // deno-lint-ignore no-control-regex
  if (!/[^\x00-\x7F]/.test(value)) {
    return value;
  }
  return Option.liftThrowable(() => {
    const bytes = Uint8Array.from(value, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  })().pipe(
    Option.getOrElse(() => value),
  );
}

/**
 * Extracts the object key from the request URL, given the bucket name.
 */
export function extractKey(requestUrl: string, bucket: string): string {
  const pathname = requestUrl.startsWith("/")
    ? requestUrl
    : new URL(requestUrl).pathname;
  const [pathOnly] = pathname.split("?");

  const bucketPrefixWithSlash = `/${bucket}/`;
  const bucketPrefixNoSlash = `/${bucket}`;

  if (pathOnly.startsWith(bucketPrefixWithSlash)) {
    return decodeURIComponent(pathOnly.substring(bucketPrefixWithSlash.length));
  } else if (pathOnly === bucketPrefixNoSlash) {
    return "";
  }
  return "";
}

/**
 * Resolves a bucket by name and runs the provided effect with the resolved backend.
 * Centralizes error handling via S3Xml.formatError.
 */
export function resolveBucket<
  A extends HttpServerResponse.HttpServerResponse,
  E,
  R,
>(
  bucketName: string,
  fn: (backend: typeof Backend.Service) => Effect.Effect<A, E, R | Backend>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  BadGateway,
  | R
  | BackendResolver
  | S3Xml
  | AppConfig
  | S3Client
  | SwiftClient
  | HttpServerRequest.HttpServerRequest
> {
  return Effect.gen(function* () {
    const resolver = yield* BackendResolver;
    const s3Xml = yield* S3Xml;
    const request = yield* Effect.serviceOption(
      HttpServerRequest.HttpServerRequest,
    );
    const isHead = Option.isSome(request)
      ? request.value.method === "HEAD"
      : false;

    if (Option.isSome(request)) {
      const auth = request.value.headers["authorization"];
      yield* Effect.logDebug(
        `${request.value.method} ${request.value.url} auth: [${auth}]`,
      );
      if (
        !auth || auth.trim() === "" ||
        (auth.startsWith("AWS ") && auth.split(":").length < 2 &&
          !auth.includes("Signature=")) ||
        (auth.startsWith("AWS4-") && !auth.includes("Signature="))
      ) {
        return s3Xml.formatError(
          new AccessDenied({
            message: "Access Denied",
          }),
          isHead,
        );
      }
    }

    const program = Effect.gen(function* () {
      const backend = yield* Backend;
      return yield* fn(backend);
    });

    return yield* resolver.provideForBucket(bucketName, program).pipe(
      Effect.catchAll((e) => {
        if (
          e instanceof NoSuchBucket ||
          e instanceof NoSuchKey ||
          e instanceof BucketAlreadyExists ||
          e instanceof BucketAlreadyOwnedByYou ||
          e instanceof InternalError ||
          e instanceof AccessDenied ||
          e instanceof BucketNotEmpty ||
          e instanceof NoSuchUpload ||
          e instanceof InvalidPart ||
          e instanceof InvalidPartOrder ||
          e instanceof EntityTooSmall ||
          e instanceof InvalidRequest ||
          e instanceof MalformedXML ||
          e instanceof DeleteObjectsError
        ) {
          return Effect.succeed(s3Xml.formatError(e, isHead));
        }
        return Effect.logError(
          `resolveBucket caught unhandled error for bucket ${bucketName}: ${e}`,
        ).pipe(
          Effect.zipRight(
            Effect.fail(
              new BadGateway({
                message: e instanceof Error ? e.message : String(e),
              }),
            ),
          ),
        );
      }),
    );
  });
}

/**
 * Resolves a backend by ID and runs the provided effect with the resolved backend.
 * Centralizes error handling via S3Xml.formatError.
 */
export function resolveBackend<
  A extends HttpServerResponse.HttpServerResponse,
  E,
  R,
>(
  backendId: string,
  fn: (backend: typeof Backend.Service) => Effect.Effect<A, E, R | Backend>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  BadGateway,
  | R
  | BackendResolver
  | S3Xml
  | AppConfig
  | S3Client
  | SwiftClient
  | HttpServerRequest.HttpServerRequest
> {
  return Effect.gen(function* () {
    const resolver = yield* BackendResolver;
    const s3Xml = yield* S3Xml;
    const request = yield* Effect.serviceOption(
      HttpServerRequest.HttpServerRequest,
    );
    const isHead = Option.isSome(request)
      ? request.value.method === "HEAD"
      : false;

    const program = Effect.gen(function* () {
      const backend = yield* Backend;
      return yield* fn(backend);
    });

    return yield* resolver.provideForBackendId(backendId, program).pipe(
      Effect.catchAll((e) => {
        if (
          e instanceof NoSuchBucket ||
          e instanceof NoSuchKey ||
          e instanceof BucketAlreadyExists ||
          e instanceof BucketAlreadyOwnedByYou ||
          e instanceof InternalError ||
          e instanceof AccessDenied ||
          e instanceof BucketNotEmpty ||
          e instanceof NoSuchUpload ||
          e instanceof InvalidPart ||
          e instanceof InvalidPartOrder ||
          e instanceof EntityTooSmall ||
          e instanceof InvalidRequest ||
          e instanceof MalformedXML ||
          e instanceof DeleteObjectsError
        ) {
          return Effect.succeed(s3Xml.formatError(e, isHead));
        }
        return Effect.logError(
          `resolveBackend caught unhandled error for backend ${backendId}: ${e}`,
        ).pipe(
          Effect.zipRight(
            Effect.fail(
              new BadGateway({
                message: e instanceof Error ? e.message : String(e),
              }),
            ),
          ),
        );
      }),
    );
  });
}
