import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { extractKey, resolveBucket } from "../Utils.ts";

/**
 * Handler for DeleteObject (DELETE /:bucket/*)
 */
export const deleteObject = (
  { path: { bucket } }: { path: { bucket: string } },
) =>
  resolveBucket(bucket, (backend) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const key = extractKey(request.url, bucket);

      yield* backend.deleteObject(key);
      return HttpServerResponse.empty({ status: 204 });
    }));
