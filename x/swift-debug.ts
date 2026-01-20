#!/usr/bin/env -S deno run --allow-all
import { Effect, Logger, LogLevel } from "effect";
import { SwiftClient, SwiftClientLive } from "../src/Backends/Swift/Client.ts";
import { HeraldConfigLive } from "../src/Config/Layer.ts";
import { makeSwiftBackend } from "../src/Backends/Swift/Backend.ts";
import { FetchHttpClient } from "@effect/platform";

const program = Effect.gen(function* () {
  console.log("Checking Swift connection...");

  // We'll use the 'default' backend which should be configured via HERALD_ env vars
  const backendId = "default";

  const swiftClient = yield* SwiftClient;
  const auth = yield* swiftClient.getAuthMeta({ backend_id: backendId });

  console.log("Auth successful!");
  console.log(`Storage URL: ${auth.storageUrl}`);
  console.log(`Token: ${auth.token.substring(0, 10)}...`);

  const backend = yield* makeSwiftBackend({ backend_id: backendId });
  const { buckets } = yield* backend.listBuckets();

  console.log(`Found ${buckets.length} buckets:`);
  for (const b of buckets) {
    console.log(` - ${b.name} (created: ${b.creationDate})`);
  }
}).pipe(
  Effect.provide(SwiftClientLive),
  Effect.provide(HeraldConfigLive),
  Effect.provide(FetchHttpClient.layer),
  Effect.provide(Logger.minimumLogLevel(LogLevel.Debug)),
);

if (import.meta.main) {
  Effect.runPromiseExit(program).then((exit) => {
    if (exit._tag === "Failure") {
      console.error("Program failed:", exit.cause);
      Deno.exit(1);
    }
  });
}
