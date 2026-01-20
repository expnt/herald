import { Effect } from "effect";
import { HttpServerResponse } from "@effect/platform";
import { RequestContext } from "../Utils.ts";

/**
 * Handler for PutObject (PUT /:bucket/*)
 */
export const putObject = () =>
  Effect.gen(function* () {
    const { backend, key, params, request } = yield* RequestContext;

    if (params.partNumber && params.uploadId) {
      // Upload Part
      const result = yield* backend.uploadPart(
        key,
        params.uploadId,
        params.partNumber,
        request.stream,
      );
      return HttpServerResponse.empty({
        status: 200,
        headers: { ETag: result.etag },
      });
    }

    const result = yield* backend.putObject(
      key,
      request.stream,
      request.headers,
    );
    const headers: Record<string, string> = {};
    if (result.etag) headers["ETag"] = result.etag;
    if (result.versionId) headers["x-amz-version-id"] = result.versionId;

    return HttpServerResponse.empty({
      status: 200,
      headers,
    });
  });
