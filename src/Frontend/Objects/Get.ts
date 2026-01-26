import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import { Backend, InvalidRequest } from "../../Services/Backend.ts";
import { S3Xml } from "../../Services/S3Xml.ts";
import { S3RequestParser } from "../Utils.ts";

/**
 * Handler for GetObjectAttributes (GET /:bucket/*?attributes)
 */
export const getObjectAttributes = () =>
  Effect.gen(function* () {
    const backend = yield* Backend;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const parser = yield* S3RequestParser;
    const key = yield* parser.key;
    const { objectAttributes } = yield* parser.headers;

    yield* Effect.logDebug(
      `getObjectAttributes key=[${key}] attributes=[${
        objectAttributes.join(",")
      }]`,
    );
    const s3Xml = yield* S3Xml;

    if (objectAttributes.length === 0) {
      return s3Xml.formatError(
        new InvalidRequest({
          message: "At least one attribute must be specified.",
        }),
      );
    }

    const result = yield* backend.getObjectAttributes(
      key,
      objectAttributes,
      request.headers,
    );
    return s3Xml.formatObjectAttributes(result);
  });

/**
 * Handler for GetObject (GET /:bucket/*)
 * Also handles ListParts (?uploadId=...).
 */
export const getObject = Effect.gen(function* () {
  const backend = yield* Backend;
  const parser = yield* S3RequestParser;
  const key = yield* parser.key;
  const params = yield* parser.params;
  const request = yield* HttpServerRequest.HttpServerRequest;

  const s3Xml = yield* S3Xml;

  if (params.attributes !== undefined) {
    return yield* getObjectAttributes();
  }

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

  if (result.nativeStream) {
    return HttpServerResponse.raw(result.nativeStream, {
      status,
      headers: result.headers,
      contentType: result.contentType,
    });
  }

  return HttpServerResponse.stream(result.stream, {
    status,
    headers: result.headers,
    contentType: result.contentType,
  });
});
