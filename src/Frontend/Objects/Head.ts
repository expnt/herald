import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import { Backend } from "../../Services/Backend.ts";
import { ensureClientReadableKey } from "../../Services/InternalNamespace.ts";
import { RequestContext, S3RequestParser } from "../Utils.ts";

/**
 * Handler for HeadObject (HEAD /:bucket/*)
 */
export const headObject = Effect.gen(function* () {
  const backend = yield* Backend;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { key, s3Params } = yield* S3RequestParser;
  const { bucket } = yield* RequestContext;
  yield* ensureClientReadableKey(bucket, key);

  const combinedHeaders = { ...request.headers };
  if (s3Params.partNumber) {
    combinedHeaders["x-amz-part-number"] = String(s3Params.partNumber);
  }

  const result = yield* backend.headObject(key, combinedHeaders);
  // S3 clients (e.g. Restate) may require Content-Length on HEAD; ensure it is set when known
  const responseHeaders: Record<string, string> = { ...result.headers };
  if (
    result.contentLength !== undefined &&
    result.contentLength !== null &&
    responseHeaders["Content-Length"] === undefined
  ) {
    responseHeaders["Content-Length"] = String(result.contentLength);
  }
  return HttpServerResponse.empty({
    status: 200,
    headers: responseHeaders,
  });
});
