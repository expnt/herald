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
  const parser = yield* S3RequestParser;
  const key = yield* parser.key;
  const params = yield* parser.params;

  const combinedHeaders = { ...request.headers };
  if (params.partNumber) {
    combinedHeaders["x-amz-part-number"] = String(params.partNumber);
  }

  const result = yield* backend.headObject(key, combinedHeaders);
  return HttpServerResponse.empty({
    status: 200,
    headers: result.headers,
  });
});
