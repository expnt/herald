import { Effect } from "effect";
import { HttpServerResponse } from "@effect/platform";
import { RequestContext } from "../Utils.ts";

/**
 * Handler for HeadObject (HEAD /:bucket/*)
 */
export const headObject = () =>
  Effect.gen(function* () {
    const { backend, key, params, request } = yield* RequestContext;

    const combinedHeaders = { ...request.headers };
    if (params.partNumber) {
      combinedHeaders["x-amz-part-number"] = String(params.partNumber);
    }

    const result = yield* backend.headObject(key, combinedHeaders);
    return HttpServerResponse.empty({
      status: 200,
      headers: result.headers,
    });
  });
