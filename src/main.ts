import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Layer } from "effect";
// our http server impl layer
import { HttpLive } from "./Http.ts";
// otel tracing layer
import { TracingLive } from "./Tracing.ts";

HttpLive.pipe(
  Layer.provide(TracingLive),
  Layer.provide(NodeHttpClient.layer),
  Layer.launch,
  NodeRuntime.runMain,
);
