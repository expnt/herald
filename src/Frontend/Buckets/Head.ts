import { Effect } from "effect";
import { HttpServerResponse } from "@effect/platform";
import { RequestContext } from "../Utils.ts";

export const headBucket = () =>
  Effect.gen(function* () {
    const { backend } = yield* RequestContext;
    yield* backend.headBucket();
    return HttpServerResponse.empty({ status: 200 });
  });
