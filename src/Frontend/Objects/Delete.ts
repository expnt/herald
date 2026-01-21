import { Effect } from "effect";
import { HttpServerResponse } from "@effect/platform";
import { RequestContext } from "../Utils.ts";

/**
 * Handler for DeleteObject (DELETE /:bucket/*)
 */
export const deleteObject = () =>
  Effect.gen(function* () {
    const { backend, key, params } = yield* RequestContext;

    if (params.uploadId) {
      // Abort Multipart Upload
      yield* backend.abortMultipartUpload(key, params.uploadId);
      yield* backend.multipartMetadataStore.remove(params.uploadId).pipe(
        Effect.ignore,
      );
      return HttpServerResponse.empty({ status: 204 });
    }

    yield* backend.deleteObject(key);
    return HttpServerResponse.empty({ status: 204 });
  });
