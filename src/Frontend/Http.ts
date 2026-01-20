import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { Effect, Layer } from "effect";
import { HttpHeraldApi } from "../Api.ts";
import { listBuckets } from "./Buckets/List.ts";
import { createBucket } from "./Buckets/Create.ts";
import { deleteBucket } from "./Buckets/Delete.ts";
import { headBucket } from "./Buckets/Head.ts";
import { listObjects } from "./Objects/List.ts";
import { getObject } from "./Objects/Get.ts";
import { putObject } from "./Objects/Put.ts";
import { deleteObject } from "./Objects/Delete.ts";
import { headObject } from "./Objects/Head.ts";
import { postObject } from "./Objects/Post.ts";
import { S3ClientLive } from "../Backends/S3/Client.ts";
import { SwiftClientLive } from "../Backends/Swift/Client.ts";
import { S3XmlLive } from "../Services/S3Xml.ts";
import { BackendResolverLive } from "../Services/BackendResolver.ts";
import { provideRequestContext } from "./Utils.ts";

export const HttpS3Live = HttpApiBuilder.group(
  HttpHeraldApi,
  "s3",
  (handlers) =>
    handlers
      // handleRaw is preferred througout since
      // we want to return XML directly
      // after setting our own
      .handleRaw("postRoot", (_handlers) =>
        Effect.gen(function* () {
          yield* Effect.logDebug("POST / received");
          // FIXME: what's the purose of this handler?
          // 200 diverges from 502 as defiend in the openapi
          return HttpServerResponse.text("", { status: 200 });
        }))
      .handleRaw("listBuckets", listBuckets)
      .handleRaw("createBucket", provideRequestContext(createBucket))
      .handleRaw("deleteBucket", provideRequestContext(deleteBucket))
      .handleRaw("headBucket", provideRequestContext(headBucket))
      .handleRaw("listObjects", provideRequestContext(listObjects))
      .handleRaw("postBucket", provideRequestContext(postObject))
      .handleRaw("getObject", provideRequestContext(getObject))
      .handleRaw("putObject", provideRequestContext(putObject))
      .handleRaw("postObject", provideRequestContext(postObject))
      .handleRaw("deleteObject", provideRequestContext(deleteObject))
      .handleRaw("headObject", provideRequestContext(headObject)),
).pipe(
  Layer.provide(BackendResolverLive),
  Layer.provide(S3ClientLive),
  Layer.provide(SwiftClientLive),
  Layer.provide(S3XmlLive),
);
