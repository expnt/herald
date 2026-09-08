import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { RequestContext } from "../Utils.ts";
import { Backend } from "../../Services/Backend.ts";

export const createBucket = Effect.gen(function* () {
  const backend = yield* Backend;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { bucket, sigV4Context } = yield* RequestContext;

  yield* backend.createBucket(
    bucket,
    request.headers,
    sigV4Context
      ? { id: sigV4Context.accessKeyId, displayName: sigV4Context.accessKeyId }
      : undefined,
  );
  return HttpServerResponse.text("", { status: 200 });
});
