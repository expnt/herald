import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import {
  Backend,
  type CannedAcl,
  InvalidArgument,
} from "../../Services/Backend.ts";
import { isCannedAcl } from "../../Services/Acl.ts";
import { S3Xml } from "../../Services/S3Xml.ts";
import { S3RequestParser } from "../Utils.ts";

const getHeaderValue = (
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined => {
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  if (!entry) return undefined;
  const value = entry[1];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * Handler for GET /:bucket/*?acl
 * Returns the object's AccessControlPolicy as XML.
 */
export const getObjectAcl = Effect.gen(function* () {
  const backend = yield* Backend;
  const s3Xml = yield* S3Xml;
  const { key } = yield* S3RequestParser;

  const policy = yield* backend.getObjectAcl(key);
  return s3Xml.formatAccessControlPolicy(policy);
});

/**
 * Handler for PUT /:bucket/*?acl
 * Accepts either an x-amz-acl canned ACL header or an AccessControlPolicy XML
 * body, and persists the resulting policy on the backend.
 */
export const putObjectAcl = Effect.gen(function* () {
  const backend = yield* Backend;
  const s3Xml = yield* S3Xml;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { key } = yield* S3RequestParser;

  const cannedAcl = getHeaderValue(request.headers, "x-amz-acl");
  if (cannedAcl !== undefined) {
    if (!isCannedAcl(cannedAcl)) {
      return yield* Effect.fail(
        new InvalidArgument({
          message: "Argument x-amz-acl is invalid.",
        }),
      );
    }
    yield* backend.putObjectAcl(key, cannedAcl as CannedAcl);
    return HttpServerResponse.text("", { status: 200 });
  }

  const body = yield* request.text;
  const policy = yield* s3Xml.parseAccessControlPolicy(body);
  yield* backend.putObjectAcl(key, policy);
  return HttpServerResponse.text("", { status: 200 });
});
