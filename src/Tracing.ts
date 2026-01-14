import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import "@opentelemetry/sdk-trace-node"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Config, Effect, Layer, Option } from "effect"

export const TracingLive = Layer.unwrapEffect(
    Effect.gen(function* () {
        const dataset = yield* Config.withDefault(
            Config.string("OTEL_SERVICE_NAME"),
            "herald"
        )
        const endpoint = yield* Config.option(
            Config.string("OTEL_EXPORTER_OTLP_ENDPOINT")
        )

        if (Option.isNone(endpoint)) {
            return Layer.empty
        }

        return NodeSdk.layer(() => ({
            resource: {
                serviceName: dataset
            },
            spanProcessor: new BatchSpanProcessor(
                new OTLPTraceExporter({ url: `${endpoint.value}/v1/traces` })
            )
        }))
    })
)

