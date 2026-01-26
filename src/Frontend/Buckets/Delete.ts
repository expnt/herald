import { Effect } from "effect";
import { HttpServerResponse } from "@effect/platform";
import { Backend } from "../../Services/Backend.ts";

export const deleteBucket = Effect.gen(function* () {
  const backend = yield* Backend;
  yield* backend.deleteBucket();
  return HttpServerResponse.empty({ status: 204 });
});
