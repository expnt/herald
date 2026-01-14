import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform"
import { Schema } from "effect"

export class HealthApi extends HttpApiGroup.make("health")
    .add(
        HttpApiEndpoint.get("getStatus", "/health")
            .addSuccess(Schema.Struct({ status: Schema.Literal("ok") }))
    )
    .annotate(OpenApi.Title, "Health")
    .annotate(OpenApi.Description, "Health check endpoint")
{ }

