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

export { Api } from "./Api.ts";
export { HttpHealthLive } from "./Frontend/Health/Http.ts";
export { HttpS3Live } from "./Frontend/Http.ts";
import { AppConfigLive } from "./Config/Layer.ts";
import { HttpHealthLive } from "./Frontend/Health/Http.ts";
import { HttpS3Live } from "./Frontend/Http.ts";
import { Api } from "./Api.ts";

export const ApiLive = HttpApiBuilder.api(Api).pipe(
  Layer.provide(HttpHealthLive),
  Layer.provide(HttpS3Live),
);

export const HttpLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const port = yield* Config.withDefault(
      Config.integer("PORT"),
      3000,
    );
    return HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
      Layer.provide(HttpApiSwagger.layer()),
      Layer.provide(HttpApiBuilder.middlewareOpenApi()),
      Layer.provide(HttpApiBuilder.middlewareCors()),
      Layer.provide(ApiLive),
      HttpServer.withLogAddress,
      Layer.provide(NodeHttpServer.layer(createServer, { port })),
      Layer.provide(AppConfigLive),
    );
  }),
);
