import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { extractKey, resolveBucket } from "../Utils.ts";

/**
 * Handler for GetObject (GET /:bucket/*)
 */
export const getObject = ({ path: { bucket } }: { path: { bucket: string } }) =>
  resolveBucket(bucket, (backend) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const key = extractKey(request.url, bucket);

      const result = yield* backend.getObject(key);
      return HttpServerResponse.stream(result.stream, {
        status: 200,
        headers: result.headers,
        contentType: result.contentType,
      });
    }));
