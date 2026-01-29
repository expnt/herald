import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import { Backend, InvalidRequest } from "../../Services/Backend.ts";
import { S3Xml } from "../../Services/S3Xml.ts";
import { S3RequestParser } from "../Utils.ts";
import { listParts } from "../Multipart/Get.ts";

/**
 * Handler for GetObjectAttributes (GET /:bucket/*?attributes)
 */
export const getObjectAttributes = () =>
  Effect.gen(function* () {
    const backend = yield* Backend;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { key, headers, s3Params } = yield* S3RequestParser;

    // Attributes can come from query parameter ?attributes=... or header x-amz-object-attributes
    const attributesFromQuery = s3Params.attributes
      ? s3Params.attributes.split(",").map((a) => a.trim()).filter((a) =>
        a !== ""
      )
      : [];
    const attributesFromHeader = headers.objectAttributes;
    // Deduplicate attributes
    const allAttributes = Array.from(
      new Set([...attributesFromQuery, ...attributesFromHeader]),
    );

    yield* Effect.logDebug(
      `getObjectAttributes key=[${key}] attributes=[${
        allAttributes.join(",")
      }]`,
    );
    const s3Xml = yield* S3Xml;

    if (allAttributes.length === 0) {
      return s3Xml.formatError(
        new InvalidRequest({
          message: "At least one attribute must be specified.",
        }),
      );
    }

    const result = yield* backend.getObjectAttributes(
      key,
      allAttributes,
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
  const { key, s3Params } = yield* S3RequestParser;
  const request = yield* HttpServerRequest.HttpServerRequest;

  if (s3Params.attributes !== undefined) {
    return yield* getObjectAttributes();
  }

  if (s3Params.uploadId) {
    return yield* listParts;
  }

  const result = yield* backend.getObject(key, request.headers);
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
