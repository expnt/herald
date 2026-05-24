import { HttpServerRequest, Url } from "@effect/platform";
import { Context, Effect, Either, Schema } from "effect";
import { InternalError } from "../Services/Backend.ts";
import { S3HeaderService } from "../Services/S3HeaderService.ts";
import type { SigV4VerifiedContext } from "../Services/Auth.ts";

/**
 * Context for S3 operations (bucket or object).
 */
export class RequestContext extends Context.Tag("RequestContext")<
  RequestContext,
  {
    readonly bucket: string;
    readonly sigV4Context?: SigV4VerifiedContext;
  }
>() {}

export interface S3RequestData {
  readonly s3Params: S3QueryParams & Record<string, unknown>;
  readonly headers: ReturnType<
    typeof S3HeaderService.Service.fromRequestHeaders
  >;
  readonly key: string;
}

export const S3RequestParser = Effect.gen(function* () {
  const { bucket } = yield* RequestContext;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const urlResult = Url.fromString(request.url, "http://localhost");
  if (Either.isLeft(urlResult)) {
    return yield* Effect.fail(
      new InternalError({ message: String(urlResult.left) }),
    );
  }
  const url = urlResult.right;
  const headerService = yield* S3HeaderService;

  const paramsRecord: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    paramsRecord[key] = value;
  });

  const s3Params = yield* Schema.decodeUnknown(S3QueryParams)(paramsRecord, {
    onExcessProperty: "ignore",
  }).pipe(
    Effect.mapError((e) => {
      return new InternalError({ message: String(e) });
    }),
  );

  const parsedHeaders = headerService.fromRequestHeaders(request.headers);

  // url.pathname from a parsed URL object does not include the query string
  const pathOnly = url.pathname;
  const bucketPrefixWithSlash = `/${bucket}/`;
  const bucketPrefixNoSlash = `/${bucket}`;

  let key = "";
  if (pathOnly.startsWith(bucketPrefixWithSlash)) {
    key = decodeURIComponent(
      pathOnly.substring(bucketPrefixWithSlash.length),
    );
  } else if (pathOnly === bucketPrefixNoSlash) {
    key = "";
  }

  // Explicitly type the merged s3Params to make the type relationship clear
  const mergedS3Params: S3QueryParams & Record<string, unknown> = {
    ...s3Params,
    ...(parsedHeaders.s3Params.uploadId
      ? { uploadId: parsedHeaders.s3Params.uploadId }
      : {}),
    ...(parsedHeaders.s3Params.partNumber
      ? { partNumber: parsedHeaders.s3Params.partNumber }
      : {}),
    ...(parsedHeaders.s3Params.contentLength !== undefined
      ? { contentLength: parsedHeaders.s3Params.contentLength }
      : {}),
  };

  return {
    s3Params: mergedS3Params,
    headers: parsedHeaders,
    key,
  };
});

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
