import { Effect, Layer, Option } from "effect";
import {
  FetchHttpClient,
  HttpApiBuilder,
  HttpApiClient,
  HttpServer,
} from "@effect/platform";
import { HeraldHttpApi, HttpHealthLive, HttpS3Live } from "../src/Http.ts";
import { HeraldConfig } from "../src/Config/Layer.ts";
import { S3ClientLive } from "../src/Backends/S3/Client.ts";
import { SwiftClientLive } from "../src/Backends/Swift/Client.ts";
import { S3XmlLive } from "../src/Services/S3Xml.ts";
import { ChecksumLive } from "../src/Services/Checksum.ts";
import { S3HeaderServiceLive } from "../src/Services/S3HeaderService.ts";
import { BackendResolverLive } from "../src/Services/BackendResolver.ts";
import { EffectAssert, testEffect } from "./utils.ts";

testEffect("health/getStatus", () =>
  Effect.gen(function* () {
    const HeraldConfigLive = Layer.succeed(HeraldConfig, {
      raw: { backends: {} },
      lookupBucket: () => Option.none(),
      resolveAuth: () => Option.none(),
      resolveAuthForBackendId: () => Option.none(),
    });

    const ApiWithRequirements = HttpApiBuilder.api(HeraldHttpApi).pipe(
      Layer.provide(HttpHealthLive),
      Layer.provide(HttpS3Live),
      Layer.provide(BackendResolverLive),
      Layer.provide(S3ClientLive),
      Layer.provide(SwiftClientLive),
      Layer.provide(S3XmlLive),
      Layer.provide(ChecksumLive),
      Layer.provide(S3HeaderServiceLive),
      Layer.provide(HeraldConfigLive),
      Layer.provide(FetchHttpClient.layer),
      Layer.provideMerge(HttpServer.layerContext),
    );

    // In @effect/platform 0.90.x, toWebHandler returns the object directly, not an Effect.
    const webHandler = HttpApiBuilder.toWebHandler(ApiWithRequirements);

    const clientProgram = Effect.gen(function* () {
      const client = yield* HttpApiClient.make(HeraldHttpApi, {
        baseUrl: "http://localhost",
      });
      return yield* client.health.getStatus();
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(Layer.succeed(FetchHttpClient.Fetch, (url, init) =>
        webHandler.handler(new Request(url, init)))),
    );

    const result = yield* clientProgram;

    yield* EffectAssert.deepStrictEqual(result, { status: "ok" });
    yield* Effect.tryPromise({
      try: () =>
        webHandler.dispose(),
      catch: (e) => new Error(`Web handler disposal failed: ${e}`),
    });
  }));
