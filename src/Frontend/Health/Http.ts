import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { Api } from "../../Api.ts";

export const HttpHealthLive = HttpApiBuilder.group(
  Api,
  "health",
  (handlers) =>
    handlers.handle(
      "getStatus",
      () => Effect.succeed({ status: "ok" as const }),
    ),
);
