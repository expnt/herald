import {
  HttpApiBuilder,
  type HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { Effect, Either, Layer, Option } from "effect";
import { HttpHeraldApi } from "../Api.ts";
import { S3ClientFactory } from "../Backends/S3/Client.ts";
import { SwiftClient } from "../Backends/Swift/Client.ts";
import { HeraldConfig } from "../Config/Layer.ts";
import { verifyIncomingSigV4 } from "../Services/Auth.ts";
import {
  AccessDenied,
  Backend,
  type BackendError,
  BadDigest,
  BucketAlreadyExists,
  BucketAlreadyOwnedByYou,
  BucketNotEmpty,
  DeleteObjectsError,
  EntityTooSmall,
  InternalError,
  InvalidArgument,
  InvalidBucketName,
  InvalidPart,
  InvalidPartOrder,
  InvalidRequest,
  MalformedXML,
  NoSuchBucket,
  NoSuchKey,
  NoSuchUpload,
} from "../Services/Backend.ts";
import { BackendResolver } from "../Services/BackendResolver.ts";
import { Checksum } from "../Services/Checksum.ts";
import { S3HeaderService } from "../Services/S3HeaderService.ts";
import { S3Xml } from "../Services/S3Xml.ts";
import { BadGateway } from "./Api.ts";
import { createBucket } from "./Buckets/Create.ts";
import { deleteBucket } from "./Buckets/Delete.ts";
import { headBucket } from "./Buckets/Head.ts";
import { listBuckets } from "./Buckets/List.ts";
import { deleteObject } from "./Objects/Delete.ts";
import { getObject } from "./Objects/Get.ts";
import { headObject } from "./Objects/Head.ts";
import { listObjects } from "./Objects/List.ts";
import { postObject } from "./Objects/Post.ts";
import { putObject } from "./Objects/Put.ts";
import { RequestContext, S3RequestParser } from "./Utils.ts";

export const HttpS3Live = HttpApiBuilder.group(
  HttpHeraldApi,
  "s3",
  (handlers) =>
    handlers
      .handleRaw("postRoot", (_handlers) =>
        Effect.gen(function* () {
          yield* Effect.logDebug("POST / received");
          return HttpServerResponse.text("", { status: 200 });
        }))
      .handleRaw("listBuckets", () => listBuckets)
      .handleRaw("createBucket", frontHandler(createBucket))
      .handleRaw("deleteBucket", frontHandler(deleteBucket))
      .handleRaw("headBucket", frontHandler(headBucket))
      .handleRaw("listObjects", frontHandler(listObjects))
      .handleRaw("postBucket", frontHandler(postObject))
      .handleRaw("getObject", frontHandler(getObject))
      .handleRaw("putObject", frontHandler(putObject))
      .handleRaw("postObject", frontHandler(postObject))
      .handleRaw("deleteObject", frontHandler(deleteObject))
      .handleRaw("headObject", frontHandler(headObject)),
).pipe(
  Layer.provide(BackendResolver.Default),
  Layer.provide(S3ClientFactory.Default),
  Layer.provide(SwiftClient.Default),
  Layer.provide(Checksum.Default),
  Layer.provide(S3Xml.Default),
  Layer.provide(S3HeaderService.Default),
);

function frontHandler(
  frontEffect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    Error | BackendError,
    | HttpServerRequest.HttpServerRequest
    | Backend
    | S3RequestParser
    | S3HeaderService
    | RequestContext
    | S3Xml
  >,
) {
  return (
    { path: { bucket }, request }: {
      request: HttpServerRequest.HttpServerRequest;
      path: { bucket: string };
    },
  ) => {
    return Effect.gen(function* () {
      const resolver = yield* BackendResolver;
      const s3Xml = yield* S3Xml;
      const backendRes = yield* Effect.either(
        resolver.getLayerForBucket(bucket),
      );
      if (Either.isLeft(backendRes)) {
        return yield* Effect.succeed(s3Xml.formatError(backendRes.left));
      }
      const isHead = request.method === "HEAD";

      {
        const heraldConfig = yield* HeraldConfig;
        const authCreds = heraldConfig.resolveAuth(bucket);
        if (Option.isNone(authCreds)) {
          return s3Xml.formatError(
            new AccessDenied({
              message: "No authentication configured for this backend",
            }),
            isHead,
          );
        }

        // Find region from config
        const materializedBucketOpt = heraldConfig.lookupBucket(bucket);
        const region = Option.isSome(materializedBucketOpt)
          ? materializedBucketOpt.value.region ?? "us-east-1"
          : "us-east-1";

        const isValid = yield* verifyIncomingSigV4(
          request,
          authCreds.value,
          region,
        );

        if (!isValid) {
          return s3Xml.formatError(
            new AccessDenied({
              message: "Access Denied",
            }),
            isHead,
          );
        }
      }
      return yield* frontEffect
        // provide all the services needed for the frontend handler
        .pipe(
          Effect.provideService(Backend, backendRes.right),
          Effect.provide(S3RequestParser.Default),
          Effect.provide(S3HeaderService.Default),
          Effect.provideService(RequestContext, {
            bucket,
          }),
          // conver the frontend errors to xml
          Effect.catchAll((err) => {
            if (
              err instanceof NoSuchBucket ||
              err instanceof NoSuchKey ||
              err instanceof BucketAlreadyExists ||
              err instanceof BucketAlreadyOwnedByYou ||
              err instanceof InternalError ||
              err instanceof AccessDenied ||
              err instanceof BucketNotEmpty ||
              err instanceof NoSuchUpload ||
              err instanceof InvalidPart ||
              err instanceof InvalidPartOrder ||
              err instanceof EntityTooSmall ||
              err instanceof InvalidRequest ||
              err instanceof BadDigest ||
              err instanceof InvalidBucketName ||
              err instanceof InvalidArgument ||
              err instanceof MalformedXML ||
              err instanceof DeleteObjectsError
            ) {
              return Effect.succeed(s3Xml.formatError(err, isHead));
            }
            return Effect.logError(
              `resolveBackend caught unhandled error for bucket ${bucket}: ${err}`,
            ).pipe(
              Effect.zipRight(
                Effect.fail(
                  new BadGateway({
                    message: err instanceof Error ? err.message : String(err),
                  }),
                ),
              ),
            );
          }),
        );
    });
  };
}
