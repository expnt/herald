import { FetchHttpClient } from "@effect/platform";
import { NodeRuntime } from "@effect/platform-node";
import { Layer } from "effect";
// our http server impl layer
import { HttpServerHeraldLive } from "./Http.ts";
// otel tracing layer
import { TracingLive } from "./Tracing.ts";
// checksum layer

HttpServerHeraldLive.pipe(
  Layer.provide(TracingLive),
  // provider an HttpClient impl based on `fetch`
  // used to talk the the swift impl
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, {
    // @ts-ignore: duplex is required for streaming body in fetch
    duplex: "half",
  })),
  // run layer until interrupted
  Layer.launch,
  // add support for Cli goodies like
  // signal mgmt, teardown, exit codes and stdio impl
  // for Logger
  NodeRuntime.runMain,
);
