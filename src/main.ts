import { FetchHttpClient } from "@effect/platform";
import { NodeRuntime } from "@effect/platform-node";
import { Layer } from "effect";
// our http server impl layer
import { HttpServerHeraldLive } from "./Http.ts";
// otel tracing layer
import { TracingLive } from "./Tracing.ts";

HttpServerHeraldLive.pipe(
  Layer.provide(TracingLive),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, {
    // @ts-ignore: duplex is required for streaming body in fetch
    duplex: "half",
  })),
  Layer.launch,
  NodeRuntime.runMain,
);
