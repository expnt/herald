import { Effect } from "effect";
import { HttpServerResponse } from "@effect/platform";
import { RequestContext } from "../Utils.ts";
import { S3Xml } from "../../Services/S3Xml.ts";
import { InvalidRequest } from "../../Services/Backend.ts";

/**
 * Handler for GetObjectAttributes (GET /:bucket/*?attributes)
 */
export const getObjectAttributes = () =>
  Effect.gen(function* () {
    const { backend, key, request } = yield* RequestContext;
    const s3Xml = yield* S3Xml;

    const attributesHeader = request.headers["x-amz-object-attributes"] ||
      request.headers["X-Amz-Object-Attributes"];
    const attributes = attributesHeader
      ? (Array.isArray(attributesHeader)
        ? attributesHeader[0]
        : attributesHeader).split(",").map((a: string) => a.trim()).filter((
          a: string,
        ) => a !== "")
      : [];

    if (attributes.length === 0) {
      return s3Xml.formatError(
        new InvalidRequest({
          message: "At least one attribute must be specified.",
        }),
      );
    }

    const result = yield* backend.getObjectAttributes(
      key,
      attributes,
      request.headers,
    );
    return s3Xml.formatObjectAttributes(result);
  });

/**
 * Handler for GetObject (GET /:bucket/*)
 * Also handles ListParts (?uploadId=...).
 */
export const getObject = () =>
  Effect.gen(function* () {
    const { backend, key, params, request } = yield* RequestContext;
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
