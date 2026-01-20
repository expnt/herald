import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { Effect, Layer } from "effect";
import { Api } from "../Api.ts";
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

export const HttpS3Live = HttpApiBuilder.group(
  Api,
  "s3",
  (handlers) =>
    handlers
      .handleRaw("postRoot", (_handlers) =>
        Effect.gen(function* () {
          yield* Effect.logDebug("POST / received");
          return HttpServerResponse.text("", { status: 200 });
        }))
      .handleRaw("listBuckets", listBuckets)
      .handleRaw("createBucket", createBucket)
      .handleRaw("deleteBucket", deleteBucket)
      .handleRaw("headBucket", headBucket)
      .handleRaw("listObjects", listObjects)
      .handleRaw("postBucket", postObject)
      .handleRaw("getObject", getObject)
      .handleRaw("putObject", putObject)
      .handleRaw("postObject", postObject)
      .handleRaw("deleteObject", deleteObject)
      .handleRaw("headObject", headObject),
).pipe(
  Layer.provide(BackendResolverLive),
  Layer.provide(S3ClientLive),
  Layer.provide(SwiftClientLive),
  Layer.provide(S3XmlLive),
);
