import { FetchHttpClient } from "@effect/platform";
import { NodeRuntime } from "@effect/platform-node";
import { Layer } from "effect";
// our http server impl layer
import { HttpLive } from "./Http.ts";
// otel tracing layer
import { TracingLive } from "./Tracing.ts";

HttpLive.pipe(
  // add otel
  Layer.provide(TracingLive),
  // provider an HttpClient impl based on `fetch`
  // used to talk the the swift impl
  Layer.provide(FetchHttpClient.layer),
  // run layer until interrupted
  Layer.launch,
  NodeRuntime.runMain,
);
