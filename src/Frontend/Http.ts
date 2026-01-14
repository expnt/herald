import { HttpApiBuilder } from "@effect/platform"
import { Layer } from "effect"
import { Api } from "../Api.ts"
import { listBuckets } from "./Buckets/List.ts"
import { createBucket } from "./Buckets/Create.ts"
import { deleteBucket } from "./Buckets/Delete.ts"
import { headBucket } from "./Buckets/Head.ts"
import { proxyObject } from "./Objects/Proxy.ts"
import { S3ClientLive } from "../Backends/S3/Client.ts"
import { S3XmlLive } from "../Services/S3Xml.ts"
import { BackendResolverLive } from "../Services/BackendResolver.ts"

export const HttpS3Live = HttpApiBuilder.group(
  Api,
  "s3",
  (handlers) =>
    handlers
      .handleRaw("listBuckets", listBuckets)
      .handleRaw("createBucket", createBucket)
      .handleRaw("deleteBucket", deleteBucket)
      .handleRaw("headBucket", headBucket)
      .handleRaw("getObject", proxyObject)
      .handleRaw("putObject", proxyObject)
      .handleRaw("deleteObject", proxyObject)
      .handleRaw("headObject", proxyObject)
).pipe(
  Layer.provide(BackendResolverLive),
  Layer.provide(S3ClientLive),
  Layer.provide(S3XmlLive)
)

