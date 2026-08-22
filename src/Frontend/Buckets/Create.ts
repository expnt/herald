import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { RequestContext } from "../Utils.ts";
import { Backend } from "../../Services/Backend.ts";

export const createBucket = Effect.gen(function* () {
  const backend = yield* Backend;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { bucket } = yield* RequestContext;

  yield* backend.createBucket(bucket, request.headers);
  return HttpServerResponse.text("", { status: 200 });
});
