import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { extractKey, resolveBucket } from "../Utils.ts";

/**
 * Handler for PutObject (PUT /:bucket/*)
 */
export const putObject = ({ path: { bucket } }: { path: { bucket: string } }) =>
  resolveBucket(bucket, (backend) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const key = extractKey(request.url, bucket);

      const result = yield* backend.putObject(
        key,
        request.stream,
        request.headers,
      );
      const headers: Record<string, string> = {};
      if (result.etag) headers["etag"] = result.etag;
      if (result.versionId) headers["x-amz-version-id"] = result.versionId;

      return HttpServerResponse.empty({
        status: 200,
        headers,
      });
    }));
