import { Effect } from "effect";
import { HttpServerResponse } from "@effect/platform";
import { RequestContext } from "../Utils.ts";

export const deleteBucket = () =>
  Effect.gen(function* () {
    const { backend } = yield* RequestContext;
    yield* backend.deleteBucket();
    return HttpServerResponse.empty({ status: 204 });
  });
