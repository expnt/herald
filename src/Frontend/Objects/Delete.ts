import { HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import { Backend } from "../../Services/Backend.ts";
import { S3RequestParser } from "../Utils.ts";

/**
 * Handler for DeleteObject (DELETE /:bucket/*)
 */
export const deleteObject = Effect.gen(function* () {
  const backend = yield* Backend;
  const parser = yield* S3RequestParser;
  const key = yield* parser.key;
  const params = yield* parser.params;

  if (params.uploadId) {
    // Abort Multipart Upload
    yield* backend.abortMultipartUpload(key, params.uploadId);
    yield* backend.multipartMetadataStore.remove(`${key}/${params.uploadId}`)
      .pipe(
        Effect.ignore,
      );
    return HttpServerResponse.empty({ status: 204 });
  }

  yield* backend.deleteObject(key);
  return HttpServerResponse.empty({ status: 204 });
});
