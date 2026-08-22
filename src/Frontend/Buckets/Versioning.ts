import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Backend, InvalidRequest } from "../../Services/Backend.ts";
import { S3Xml } from "../../Services/S3Xml.ts";
import { RequestContext } from "../Utils.ts";

const VALID_STATUSES = ["Enabled", "Suspended"] as const;
type VersioningStatus = (typeof VALID_STATUSES)[number];

const isVersioningStatus = (value: string): value is VersioningStatus =>
  (VALID_STATUSES as readonly string[]).includes(value);

/**
 * Handler for GET /:bucket?versioning
 * Returns the bucket's versioning configuration. A bucket that has never had
 * versioning configured returns an empty <VersioningConfiguration/> element.
 */
export const getBucketVersioning = Effect.gen(function* () {
  const backend = yield* Backend;
  const s3Xml = yield* S3Xml;
  const { bucket } = yield* RequestContext;

  const result = yield* backend.getBucketVersioning(bucket);
  return s3Xml.formatVersioning(result);
});

/**
 * Handler for PUT /:bucket?versioning
 * Accepts a <VersioningConfiguration><Status>Enabled|Suspended</Status>
 * </VersioningConfiguration> body and persists the requested state.
 */
export const putBucketVersioning = Effect.gen(function* () {
  const backend = yield* Backend;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { bucket } = yield* RequestContext;

  const body = yield* request.text.pipe(
    Effect.mapError((e) => new InvalidRequest({ message: String(e) })),
  );

  const statusMatch = body.match(/<Status>\s*([^<]+)\s*<\/Status>/);
  const rawStatus = statusMatch?.[1]?.trim();
  if (rawStatus === undefined || !isVersioningStatus(rawStatus)) {
    return yield* Effect.fail(
      new InvalidRequest({
        message:
          "The XML you provided was not well-formed or did not validate against our published schema.",
      }),
    );
  }

  yield* backend.putBucketVersioning(bucket, rawStatus);
  return HttpServerResponse.empty({ status: 200 });
});
