import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform";
import { Schema } from "effect";

export class BadGateway extends Schema.TaggedError<BadGateway>()("BadGateway", {
  message: Schema.String,
}) {}

export const S3Api = HttpApiGroup.make("s3")
  .add(
    HttpApiEndpoint.post("postRoot", "/")
      .addError(BadGateway, { status: 502 }),
  )
  .add(
    HttpApiEndpoint.get("listBuckets", "/")
      .addError(BadGateway, { status: 502 }),
  )
  .add(
    HttpApiEndpoint.get("listObjects", "/:bucket")
      .setPath(Schema.Struct({ bucket: Schema.String }))
      .addError(BadGateway, { status: 502 }),
  )
  .add(
    HttpApiEndpoint.put("createBucket", "/:bucket")
      .setPath(Schema.Struct({ bucket: Schema.String }))
      .addError(BadGateway, { status: 502 }),
  )
  .add(
    HttpApiEndpoint.del("deleteBucket", "/:bucket")
      .setPath(Schema.Struct({ bucket: Schema.String }))
      .addError(BadGateway, { status: 502 }),
  )
  .add(
    HttpApiEndpoint.head("headBucket", "/:bucket")
      .setPath(Schema.Struct({ bucket: Schema.String }))
      .addError(BadGateway, { status: 502 }),
  )
  .add(
    HttpApiEndpoint.post("postBucket", "/:bucket")
      .setPath(Schema.Struct({ bucket: Schema.String }))
      .addError(BadGateway, { status: 502 }),
  )
  // Object operations with wildcards to support slashes in keys
  .add(
    HttpApiEndpoint.get("getObject", "/:bucket/*")
      .setPath(Schema.Struct({ bucket: Schema.String }))
      .addError(BadGateway, { status: 502 }),
  )
  .add(
    HttpApiEndpoint.put("putObject", "/:bucket/*")
      .setPath(Schema.Struct({ bucket: Schema.String }))
      .addError(BadGateway, { status: 502 }),
  )
  .add(
    HttpApiEndpoint.post("postObject", "/:bucket/*")
      .setPath(Schema.Struct({ bucket: Schema.String }))
      .addError(BadGateway, { status: 502 }),
  )
  .add(
    HttpApiEndpoint.del("deleteObject", "/:bucket/*")
      .setPath(Schema.Struct({ bucket: Schema.String }))
      .addError(BadGateway, { status: 502 }),
  )
  .add(
    HttpApiEndpoint.head("headObject", "/:bucket/*")
      .setPath(Schema.Struct({ bucket: Schema.String }))
      .addError(BadGateway, { status: 502 }),
  )
  .annotate(OpenApi.Title, "S3 Compatibility");
