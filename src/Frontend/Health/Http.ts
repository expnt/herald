import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { HttpHeraldApi } from "../../Api.ts";

export const HttpHealthLive = HttpApiBuilder.group(
  HttpHeraldApi,
  "health",
  (handlers) =>
    handlers.handle(
      "getStatus",
      () => Effect.succeed({ status: "ok" as const }),
    ),
);
