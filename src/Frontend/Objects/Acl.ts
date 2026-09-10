import { Effect, Option } from "effect";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import {
  Backend,
  type CannedAcl,
  InvalidArgument,
} from "../../Services/Backend.ts";
import {
  aclValidationError,
  isCannedAcl,
  knownEmailsFromCredentials,
  parseGrantHeaders,
  resolveEmailGrants,
  validatePolicyGrants,
} from "../../Services/Acl.ts";
import { S3Xml } from "../../Services/S3Xml.ts";
import { RequestContext, S3RequestParser } from "../Utils.ts";
import { HeraldConfig } from "../../Config/Layer.ts";

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
 * Accepts an x-amz-acl canned ACL header, x-amz-grant-* headers, or an
 * AccessControlPolicy XML body, and persists the resulting policy on the
 * backend.
 */
export const putObjectAcl = Effect.gen(function* () {
  const backend = yield* Backend;
  const s3Xml = yield* S3Xml;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { bucket, sigV4Context } = yield* RequestContext;
  const { key } = yield* S3RequestParser;
  const config = yield* HeraldConfig;

  const owner = sigV4Context
    ? { id: sigV4Context.accessKeyId, displayName: sigV4Context.accessKeyId }
    : undefined;

  const knownIds = new Set(
    config.resolveAuth(bucket).pipe(
      Option.map((creds) => creds.map((c) => c.accessKeyId)),
      Option.getOrElse(() => [] as string[]),
    ),
  );
  const knownEmails = config.resolveAuth(bucket).pipe(
    Option.map((creds) => knownEmailsFromCredentials(creds)),
    Option.getOrElse(() => new Map<string, string>()),
  );

  const cannedAcl = getHeaderValue(request.headers, "x-amz-acl");
  if (cannedAcl !== undefined) {
    if (!isCannedAcl(cannedAcl)) {
      return yield* Effect.fail(
        new InvalidArgument({
          message: "Argument x-amz-acl is invalid.",
        }),
      );
    }
    yield* backend.putObjectAcl(key, cannedAcl as CannedAcl, owner);
    return HttpServerResponse.text("", { status: 200 });
  }

  // x-amz-grant-* headers fully define the ACL: S3 replaces the policy with
  // exactly the header grants instead of merging into the default policy.
  const grantHeaders = parseGrantHeaders(request.headers);
  if (grantHeaders !== undefined) {
    const resolved = resolveEmailGrants(
      { owner: owner!, grants: grantHeaders },
      knownEmails,
    );
    const validationError = validatePolicyGrants(resolved, knownIds);
    if (validationError !== undefined) {
      return yield* aclValidationError(validationError);
    }
    yield* backend.putObjectAcl(key, resolved, owner);
    return HttpServerResponse.text("", { status: 200 });
  }

  const body = yield* request.text;
  const parsed = yield* s3Xml.parseAccessControlPolicy(body);
  const policy = resolveEmailGrants(parsed, knownEmails);
  const validationError = validatePolicyGrants(policy, knownIds);
  if (validationError !== undefined) {
    return yield* aclValidationError(validationError);
  }
  yield* backend.putObjectAcl(key, policy, owner);
  return HttpServerResponse.text("", { status: 200 });
});
