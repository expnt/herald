import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import {
  Backend,
  InvalidRequest,
  NoSuchBucket,
  NoSuchKey,
  PreconditionFailed,
} from "../../Services/Backend.ts";
import { ensureClientReadableKey } from "../../Services/InternalNamespace.ts";
import { S3Xml } from "../../Services/S3Xml.ts";
import { RequestContext, S3RequestParser } from "../Utils.ts";
import { listParts } from "../Multipart/Get.ts";
import {
  evaluatePreconditions,
  hasConditionalHeaders,
  parseConditionalHeaders,
  stripConditionalHeaders,
} from "./Conditional.ts";

/**
 * Handler for GetObjectAttributes (GET /:bucket/*?attributes)
 */
export const getObjectAttributes = () =>
  Effect.gen(function* () {
    const backend = yield* Backend;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { key, headers, s3Params } = yield* S3RequestParser;
    const { bucket } = yield* RequestContext;
    yield* ensureClientReadableKey(bucket, key);

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
  const { key, s3Params, headers } = yield* S3RequestParser;
  const { bucket } = yield* RequestContext;
  const request = yield* HttpServerRequest.HttpServerRequest;
  yield* ensureClientReadableKey(bucket, key);

  // Route to getObjectAttributes if attributes are specified in query or header
  if (
    s3Params.attributes !== undefined ||
    (headers.objectAttributes && headers.objectAttributes.length > 0)
  ) {
    return yield* getObjectAttributes();
  }

  if (s3Params.uploadId) {
    return yield* listParts;
  }

  // RFC 7232 conditional requests: evaluate against the current
  // representation before streaming the body. headObject is cheap (no body)
  // and both backends expose ETag/Last-Modified through it.
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
        method: "GET",
      });
      if (outcome.kind === "notModified") {
        const headers: Record<string, string> = {};
        if (head.etag) headers["ETag"] = head.etag;
        if (head.lastModified) {
          headers["Last-Modified"] = head.lastModified.toUTCString();
        }
        return HttpServerResponse.empty({ status: 304, headers });
      }
      if (outcome.kind === "preconditionFailed") {
        const s3Xml = yield* S3Xml;
        return s3Xml.formatError(
          new PreconditionFailed({
            message:
              "At least one of the pre-conditions you specified did not hold",
          }),
        );
      }
    }
    // Object missing: fall through to getObject so it produces the normal
    // 404 NoSuchKey response.
  }

  const result = yield* backend.getObject(
    key,
    stripConditionalHeaders(request.headers),
  );
  const status = (request.headers["range"] || request.headers["Range"])
    ? 206
    : 200;

  // S3 clients (e.g. Restate) may require Content-Length; ensure it is set when known
  const responseHeaders: Record<string, string> = {
    ...result.headers,
  };
  if (
    result.contentLength !== undefined &&
    result.contentLength !== null &&
    responseHeaders["Content-Length"] === undefined
  ) {
    responseHeaders["Content-Length"] = String(result.contentLength);
  }

  if (result.nativeStream) {
    return HttpServerResponse.raw(result.nativeStream, {
      status,
      headers: responseHeaders,
      contentType: result.contentType,
    });
  }

  return HttpServerResponse.stream(result.stream, {
    status,
    headers: responseHeaders,
    contentType: result.contentType,
  });
});
