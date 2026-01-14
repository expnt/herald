import { HttpApiGroup, HttpApiEndpoint, OpenApi } from "@effect/platform"
import { Schema } from "effect"

export class BadGateway extends Schema.TaggedError<BadGateway>()("BadGateway", {
  message: Schema.String
}) {}

export class S3Api extends HttpApiGroup.make("s3")
    .add(
        HttpApiEndpoint.get("listBuckets", "/")
            .addError(BadGateway, { status: 502 })
    )
    .add(
        HttpApiEndpoint.put("createBucket", "/:bucket")
            .setPath(Schema.Struct({ bucket: Schema.String }))
            .addError(BadGateway, { status: 502 })
    )
    .add(
        HttpApiEndpoint.del("deleteBucket", "/:bucket")
            .setPath(Schema.Struct({ bucket: Schema.String }))
            .addError(BadGateway, { status: 502 })
    )
    .add(
        HttpApiEndpoint.head("headBucket", "/:bucket")
            .setPath(Schema.Struct({ bucket: Schema.String }))
            .addError(BadGateway, { status: 502 })
    )
    .add(
        HttpApiEndpoint.get("getObject", "/:bucket/:key+")
            .setPath(Schema.Struct({ bucket: Schema.String, key: Schema.String }))
            .addError(BadGateway, { status: 502 })
    )
    .add(
        HttpApiEndpoint.put("putObject", "/:bucket/:key+")
            .setPath(Schema.Struct({ bucket: Schema.String, key: Schema.String }))
            .addError(BadGateway, { status: 502 })
    )
    .add(
        HttpApiEndpoint.del("deleteObject", "/:bucket/:key+")
            .setPath(Schema.Struct({ bucket: Schema.String, key: Schema.String }))
            .addError(BadGateway, { status: 502 })
    )
    .add(
        HttpApiEndpoint.head("headObject", "/:bucket/:key+")
            .setPath(Schema.Struct({ bucket: Schema.String, key: Schema.String }))
            .addError(BadGateway, { status: 502 })
    )
    .annotate(OpenApi.Title, "S3 Compatibility")
{ }

