import { Effect } from "effect";
import { HttpServerResponse } from "@effect/platform";
import { RequestContext } from "../Utils.ts";
import { S3Xml } from "../../Services/S3Xml.ts";

/**
 * Handler for GetObject (GET /:bucket/*)
 * Also handles ListParts (?uploadId=...).
 */
export const getObject = () =>
  Effect.gen(function* () {
    const { backend, key, params, request } = yield* RequestContext;
    const s3Xml = yield* S3Xml;

    if (params.uploadId) {
      // List Parts
      const result = yield* backend.listParts(key, params.uploadId);
      return s3Xml.formatListParts(result);
    }

    const combinedHeaders = { ...request.headers };
    if (params.partNumber) {
      combinedHeaders["x-amz-part-number"] = String(params.partNumber);
    }

    const result = yield* backend.getObject(key, combinedHeaders);
    const status = (request.headers["range"] || request.headers["Range"])
      ? 206
      : 200;
    return HttpServerResponse.stream(result.stream, {
      status,
      headers: result.headers,
      contentType: result.contentType,
    });
  });
