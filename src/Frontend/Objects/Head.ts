import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { extractKey, resolveBucket } from "../Utils.ts";

/**
 * Handler for HeadObject (HEAD /:bucket/*)
 */
export const headObject = (
  { path: { bucket } }: { path: { bucket: string } },
) =>
  resolveBucket(bucket, (backend) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const key = extractKey(request.url, bucket);
      const url = new URL(request.url, "http://localhost");
      const combinedHeaders = { ...request.headers };
      if (url.searchParams.has("partNumber")) {
        combinedHeaders["x-amz-part-number"] = url.searchParams.get(
          "partNumber",
        )!;
      }

      const result = yield* backend.headObject(key, combinedHeaders);
      return HttpServerResponse.empty({
        status: 200,
        headers: result.headers,
      });
    }));
