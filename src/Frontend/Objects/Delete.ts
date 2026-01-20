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
      const url = new URL(request.url, "http://localhost");
      const searchParams = url.searchParams;

      if (searchParams.has("uploadId")) {
        // Abort Multipart Upload
        const uploadId = searchParams.get("uploadId")!;
        yield* backend.abortMultipartUpload(key, uploadId);
        return HttpServerResponse.empty({ status: 204 });
      }

      yield* backend.deleteObject(key);
      return HttpServerResponse.empty({ status: 204 });
    }));
