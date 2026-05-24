import { Effect } from "effect";
import { HttpServerResponse } from "@effect/platform";
import { Backend } from "../../Services/Backend.ts";
import { RequestContext } from "../Utils.ts";

export const deleteBucket = Effect.gen(function* () {
  const backend = yield* Backend;
  const { bucket } = yield* RequestContext;
  yield* backend.deleteBucket(bucket);
  return HttpServerResponse.empty({ status: 204 });
});
