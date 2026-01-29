import { Effect } from "effect";
import { HttpServerResponse } from "@effect/platform";
import { Backend } from "../../Services/Backend.ts";
import { RequestContext } from "../Utils.ts";

export const headBucket = Effect.gen(function* () {
  const backend = yield* Backend;
  const { bucket } = yield* RequestContext;
  yield* backend.headBucket(bucket);
  return HttpServerResponse.empty({ status: 200 });
});
