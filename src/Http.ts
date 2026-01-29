import {
  HttpApiBuilder,
  HttpApiSwagger,
  HttpMiddleware,
  HttpServer,
} from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Config, Effect, flow, Layer } from "effect";
import { createServer } from "node-http";

export { HttpHeraldApi as HeraldHttpApi } from "./Api.ts";
export { HttpHealthLive } from "./Frontend/Health/Http.ts";
export { HttpS3Live } from "./Frontend/Http.ts";
import { HeraldConfigLive } from "./Config/Layer.ts";
import { HttpHealthLive } from "./Frontend/Health/Http.ts";
import { HttpS3Live } from "./Frontend/Http.ts";
import { HttpHeraldApi } from "./Api.ts";
import { corsMiddleware } from "./Frontend/Cors.ts";
import { S3XmlLive } from "./Services/S3Xml.ts";
import { S3ClientFactory } from "./Backends/S3/Client.ts";
import { SwiftClient } from "./Backends/Swift/Client.ts";
import { BackendResolver } from "./Services/BackendResolver.ts";
import { S3HeaderService } from "./Services/S3HeaderService.ts";
import { Checksum } from "./Services/Checksum.ts";

export const HttpHeraldLive = HttpApiBuilder.api(HttpHeraldApi).pipe(
  Layer.provide(HttpHealthLive),
  Layer.provide(HttpS3Live),
);

export const HttpServerHeraldLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const port = yield* Config.withDefault(
      Config.integer("PORT"),
      3000,
    );
    const middleware = flow(corsMiddleware, HttpMiddleware.logger);
    return HttpApiBuilder.serve(middleware).pipe(
      Layer.provide(HttpApiSwagger.layer()),
      Layer.provide(HttpApiBuilder.middlewareOpenApi()),
      Layer.provide(HttpHeraldLive),
      Layer.provide(S3XmlLive),
      Layer.provide(BackendResolver.Default),
      Layer.provide(S3ClientFactory.Default),
      Layer.provide(SwiftClient.Default),
      Layer.provide(S3HeaderService.Default),
      Layer.provide(Checksum.Default),
      HttpServer.withLogAddress,
      Layer.provide(NodeHttpServer.layer(createServer, { port })),
      Layer.provide(HeraldConfigLive),
    );
  }),
);
