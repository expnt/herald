import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import {
  Backend,
  NoSuchBucket,
  NoSuchKey,
  PreconditionFailed,
} from "../../Services/Backend.ts";
import { ensureClientReadableKey } from "../../Services/InternalNamespace.ts";
import { RequestContext, S3RequestParser } from "../Utils.ts";
import { abortMultipartUpload } from "../Multipart/Delete.ts";
import {
  evaluatePreconditions,
  hasConditionalHeaders,
  parseConditionalHeaders,
} from "./Conditional.ts";

/**
 * Handler for DeleteObject (DELETE /:bucket/*)
 */
export const deleteObject = Effect.gen(function* () {
  const backend = yield* Backend;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { key, s3Params } = yield* S3RequestParser;
  const { bucket } = yield* RequestContext;
  yield* ensureClientReadableKey(bucket, key);

  if (s3Params.uploadId) {
    return yield* abortMultipartUpload;
  }

  // RFC 7232 conditional requests: DELETE with If-Match fails with 412 on a
  // mismatch; a missing object is an idempotent 204 regardless of If-Match.
  const conditions = parseConditionalHeaders(request.headers);
  if (hasConditionalHeaders(conditions)) {
    const head = yield* backend.headObject(key, request.headers).pipe(
      Effect.catchIf(
        (e) => e instanceof NoSuchKey || e instanceof NoSuchBucket,
        () => Effect.succeed(undefined),
      ),
    );
    if (head !== undefined) {
      const outcome = evaluatePreconditions({
        conditions,
        etag: head.etag,
        lastModified: head.lastModified,
        method: "DELETE",
      });
      if (outcome.kind === "preconditionFailed") {
        return yield* Effect.fail(
          new PreconditionFailed({
            message:
              "At least one of the pre-conditions you specified did not hold",
          }),
        );
      }
    }
  }

  yield* backend.deleteObject(key);
  return HttpServerResponse.empty({
    status: 204,
    headers: {},
  });
});
