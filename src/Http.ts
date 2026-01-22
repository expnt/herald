import {
  HttpApiBuilder,
  HttpApiSwagger,
  HttpMiddleware,
  HttpServer,
} from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Config, Effect, Layer } from "effect";
// deno-lint-ignore no-external-import
import { createServer } from "node:http";

export { HttpHeraldApi as HeraldHttpApi } from "./Api.ts";
export { HttpHealthLive } from "./Frontend/Health/Http.ts";
export { HttpS3Live } from "./Frontend/Http.ts";
import { HeraldConfigLive } from "./Config/Layer.ts";
import { HttpHealthLive } from "./Frontend/Health/Http.ts";
import { HttpS3Live } from "./Frontend/Http.ts";
import { HttpHeraldApi } from "./Api.ts";

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
    return HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
      Layer.provide(HttpApiSwagger.layer()),
      Layer.provide(HttpApiBuilder.middlewareOpenApi()),
      Layer.provide(HttpHeraldLive),
      HttpServer.withLogAddress,
      Layer.provide(HttpApiBuilder.middlewareCors({
        allowedOrigins: ["*"],
        allowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD", "OPTIONS"],
        allowedHeaders: ["*"],
        exposedHeaders: ["*"],
        credentials: true,
      })),
      Layer.provide(NodeHttpServer.layer(createServer, { port })),
      Layer.provide(HeraldConfigLive),
    );
  }),
);
