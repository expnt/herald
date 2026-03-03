import { HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import { Backend } from "../../Services/Backend.ts";
import { ensureClientReadableKey } from "../../Services/InternalNamespace.ts";
import { RequestContext, S3RequestParser } from "../Utils.ts";
import { abortMultipartUpload } from "../Multipart/Delete.ts";

/**
 * Handler for DeleteObject (DELETE /:bucket/*)
 */
export const deleteObject = Effect.gen(function* () {
  const backend = yield* Backend;
  const { key, s3Params } = yield* S3RequestParser;
  const { bucket } = yield* RequestContext;
  yield* ensureClientReadableKey(bucket, key);

  if (s3Params.uploadId) {
    return yield* abortMultipartUpload;
  }

  yield* backend.deleteObject(key);
  return HttpServerResponse.empty({
    status: 204,
    headers: {},
  });
});
