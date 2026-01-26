import { Effect } from "effect";
import { HttpServerResponse } from "@effect/platform";
import { Backend } from "../../Services/Backend.ts";

export const headBucket = Effect.gen(function* () {
  const backend = yield* Backend;
  yield* backend.headBucket();
  return HttpServerResponse.empty({ status: 200 });
});
