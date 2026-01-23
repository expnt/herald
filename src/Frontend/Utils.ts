import { Context, Effect, Either, Option, Schema } from "effect";
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
import {
  HttpServerRequest,
  type HttpServerResponse,
  Url,
} from "@effect/platform";
import { HeraldConfig } from "../Config/Layer.ts";
import type { S3Client } from "../Backends/S3/Client.ts";
import type { SwiftClient } from "../Backends/Swift/Client.ts";
import { BadGateway } from "./Api.ts";
import { verifyIncomingSigV4 } from "../Services/Auth.ts";

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
 * Derives the base URL for the S3 response, using the Host header.
 */
export function deriveBaseUrl(
  request: HttpServerRequest.HttpServerRequest,
): string {
  const host = request.headers["host"] || "localhost";
  const protocol = request.url.startsWith("https") ? "https" : "http";
  return `${protocol}://${host}`;
}

/**
 * Extracts the object key from the request URL, given the bucket name.
 */
export function extractKey(requestUrl: string, bucket: string): string {
  const urlResult = Url.fromString(requestUrl, "http://localhost");
  const pathname = Either.isRight(urlResult)
    ? urlResult.right.pathname
    : requestUrl;
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
 * Context for S3 operations (bucket or object).
 */
export class RequestContext extends Context.Tag("RequestContext")<
  RequestContext,
  {
    readonly backend: typeof Backend.Service;
    readonly bucket: string;
    readonly key: string;
    readonly params: S3QueryParams;
    readonly request: HttpServerRequest.HttpServerRequest;
  }
>() {}

/**
 * Higher-order function to handle S3 context.
 */
export function provideRequestContext<
  A extends HttpServerResponse.HttpServerResponse,
  E,
  R,
>(
  fn: () => Effect.Effect<A, E, R>,
): (
  args: { path: { bucket: string } },
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  BadGateway,
  | Exclude<R, RequestContext>
  | BackendResolver
  | S3Xml
  | HeraldConfig
  | S3Client
  | SwiftClient
  | HttpServerRequest.HttpServerRequest
> {
  return ({ path: { bucket } }) =>
    resolveBucket(bucket, (backend) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const urlResult = Url.fromString(request.url, "http://localhost");
        if (Either.isLeft(urlResult)) {
          return yield* Effect.fail(
            new InternalError({ message: String(urlResult.left) }),
          );
        }
        const url = urlResult.right;
        const key = extractKey(request.url, bucket);
        const params = yield* parseQueryParams(url.searchParams, S3QueryParams);
        const ctx = {
          backend,
          bucket,
          key,
          params,
          request,
        };
        return yield* fn().pipe(Effect.provideService(RequestContext, ctx));
      }) as unknown as Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        BadGateway,
        Exclude<R, RequestContext>
      >);
}

/**
 * Common S3 Query Parameters Schema
 */
export const S3QueryParams = Schema.Struct({
  uploadId: Schema.optional(Schema.String),
  partNumber: Schema.optional(Schema.NumberFromString),
  prefix: Schema.optional(Schema.String),
  delimiter: Schema.optional(Schema.String),
  marker: Schema.optional(Schema.String),
  "max-keys": Schema.optional(Schema.NumberFromString),
  "max-uploads": Schema.optional(Schema.NumberFromString),
  "encoding-type": Schema.optional(Schema.String),
  "continuation-token": Schema.optional(Schema.String),
  "start-after": Schema.optional(Schema.String),
  "list-type": Schema.optional(Schema.String),
  "version-id-marker": Schema.optional(Schema.String),
  "key-marker": Schema.optional(Schema.String),
  "upload-id-marker": Schema.optional(Schema.String),
  versions: Schema.optional(Schema.String),
  uploads: Schema.optional(Schema.String),
  delete: Schema.optional(Schema.String),
  acl: Schema.optional(Schema.String),
  attributes: Schema.optional(Schema.String),
});

export type S3QueryParams = Schema.Schema.Type<typeof S3QueryParams>;

/**
 * Utility to parse search params using a Schema.
 */
export function parseQueryParams<A, I, R>(
  searchParams: URLSearchParams,
  schema: Schema.Schema<A, I, R>,
): Effect.Effect<A, InternalError, R> {
  const paramsRecord: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    paramsRecord[key] = value;
  });
  return Schema.decodeUnknown(schema)(paramsRecord).pipe(
    Effect.mapError((e) => new InternalError({ message: String(e) })),
  );
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
  | HeraldConfig
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
      const heraldConfig = yield* HeraldConfig;
      const authCreds = heraldConfig.resolveAuth(bucketName);

      if (Option.isNone(authCreds)) {
        return s3Xml.formatError(
          new AccessDenied({
            message: "No authentication configured for this bucket",
          }),
          isHead,
        );
      }

      const materializedBucketOpt = heraldConfig.lookupBucket(bucketName);
      const region = Option.isSome(materializedBucketOpt)
        ? materializedBucketOpt.value.region ?? "us-east-1"
        : "us-east-1";

      const verifyResult = yield* verifyIncomingSigV4(
        request.value,
        authCreds.value,
        region,
      ).pipe(Effect.either);

      if (Either.isLeft(verifyResult)) {
        return s3Xml.formatError(
          new InternalError({ message: String(verifyResult.left) }),
          isHead,
        );
      }
      const isValid = verifyResult.right;

      if (!isValid) {
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
        return Effect.logInfo(
          `resolveBucket caught error for bucket ${bucketName}: ${e}`,
        ).pipe(
          Effect.flatMap(() => {
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
  | HeraldConfig
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
      const heraldConfig = yield* HeraldConfig;
      const authCreds = heraldConfig.resolveAuthForBackendId(backendId);

      if (Option.isNone(authCreds)) {
        return s3Xml.formatError(
          new AccessDenied({
            message: "No authentication configured for this backend",
          }),
          isHead,
        );
      }

      // Find region from config
      const backend = heraldConfig.raw.backends[backendId];
      const region = backend?.region ?? "us-east-1";

      const verifyResult = yield* verifyIncomingSigV4(
        request.value,
        authCreds.value,
        region,
      ).pipe(Effect.either);

      if (Either.isLeft(verifyResult)) {
        return s3Xml.formatError(
          new InternalError({ message: String(verifyResult.left) }),
          isHead,
        );
      }
      const isValid = verifyResult.right;

      if (!isValid) {
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
