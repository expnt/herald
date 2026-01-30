import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import { Backend } from "../../Services/Backend.ts";
import { S3RequestParser } from "../Utils.ts";

/**
 * Handler for HeadObject (HEAD /:bucket/*)
 */
export const headObject = Effect.gen(function* () {
  const backend = yield* Backend;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { key, s3Params } = yield* S3RequestParser;

  const combinedHeaders = { ...request.headers };
  if (s3Params.partNumber) {
    combinedHeaders["x-amz-part-number"] = String(s3Params.partNumber);
  }

  const result = yield* backend.headObject(key, combinedHeaders);
  return HttpServerResponse.empty({
    status: 200,
    headers: result.headers,
  });
});
