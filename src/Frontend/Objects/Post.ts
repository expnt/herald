import { Effect, Option, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { RequestContext, S3RequestParser } from "../Utils.ts";
import { S3HeaderService } from "../../Services/S3HeaderService.ts";
import { parseDeleteObjectsRequest } from "../../Services/XmlParser.ts";
import { Backend } from "../../Services/Backend.ts";
import { S3Xml } from "../../Services/S3Xml.ts";
import { HeraldConfig } from "../../Config/Layer.ts";
import {
  completeMultipartUpload,
  initiateMultipartUpload,
} from "../Multipart/Post.ts";
import { parseMultipartFormData } from "../../Services/MultipartForm.ts";
import {
  getSecretForAccessKey,
  parsePolicyJson,
  validatePolicyConditions,
  verifyPolicySignatureV2,
} from "./PostObject.ts";
import {
  AccessDenied,
  InvalidRequest,
  NoSuchBucket,
} from "../../Services/Backend.ts";

/**
 * Handler for POST requests on buckets or objects.
 * Primarily used for Multi-Object Delete (POST /:bucket?delete).
 * Also handles InitiateMultipartUpload (?uploads), CompleteMultipartUpload (?uploadId=...),
 * and S3 PostObject (multipart/form-data with policy + signature).
 */
export const postObject = Effect.gen(function* () {
  const backend = yield* Backend;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { s3Params, key: pathKey } = yield* S3RequestParser;
  const { bucket } = yield* RequestContext;
  const s3Xml = yield* S3Xml;

  yield* Effect.logDebug(
    `POST bucket=${bucket} delete=${s3Params.delete !== undefined} uploads=${
      s3Params.uploads !== undefined
    } uploadId=${!!s3Params.uploadId}`,
  );

  if (s3Params.delete !== undefined) {
    // Multi-Object Delete
    const bodyText = yield* request.text;
    const objects = yield* parseDeleteObjectsRequest(bodyText);

    if (objects.length > 0) {
      const deleteResult = yield* backend.deleteObjects(objects);
      return s3Xml.formatDeleteObjects(deleteResult);
    }
    // If no keys, still return empty result
    return HttpServerResponse.text(
      `<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></DeleteResult>`,
      { headers: { "Content-Type": "application/xml" } },
    );
  }

  if (s3Params.uploads !== undefined) {
    return yield* initiateMultipartUpload;
  }

  if (s3Params.uploadId) {
    return yield* completeMultipartUpload;
  }

  // PostObject: multipart/form-data with policy + signature
  const contentType = request.headers["content-type"] ??
    request.headers["Content-Type"];
  const contentTypeStr = Array.isArray(contentType)
    ? contentType[0]
    : contentType;
  if (
    typeof contentTypeStr === "string" &&
    contentTypeStr.toLowerCase().startsWith("multipart/form-data")
  ) {
    yield* Effect.logDebug("PostObject: Content-Type is multipart/form-data");
    const bodyText = yield* request.text;
    yield* Effect.logDebug(
      `PostObject: body length=${bodyText.length} boundary in type=${
        contentTypeStr.includes("boundary")
      }`,
    );
    const parsed = yield* parseMultipartFormData(bodyText, contentTypeStr).pipe(
      Effect.catchAll((e) => Effect.fail(e)),
    );
    const { fields, filePart } = parsed;
    const fieldNames = Object.keys(fields).join(",");
    yield* Effect.logDebug(
      `PostObject: parsed fields=[${fieldNames}] filePart=${
        filePart ? "yes" : "no"
      }`,
    );
    // S3 PostObject allows case-insensitive condition field names (e.g. pOLICy)
    const field = (name: string) => {
      const lower = name.toLowerCase();
      const key = Object.keys(fields).find((k) => k.toLowerCase() === lower);
      return key ? fields[key] : undefined;
    };
    const policyB64 = field("policy");
    const signatureVal = field("signature") ?? fields["x-amz-signature"];
    const hasSignature = !!signatureVal;
    if (policyB64 && hasSignature) {
      yield* Effect.logDebug(
        "PostObject: policy and signature present, validating",
      );
      const keyFromForm = field("key") ?? pathKey;
      if (!keyFromForm || keyFromForm.trim() === "") {
        return yield* Effect.fail(
          new InvalidRequest({ message: "Missing key in form" }),
        );
      }
      if (!filePart) {
        return yield* Effect.fail(
          new InvalidRequest({ message: "Missing file or content part" }),
        );
      }
      let objectKey = keyFromForm.trim();
      if (objectKey === "${filename}" && filePart.filename) {
        objectKey = filePart.filename;
      } else if (objectKey === "${filename}") {
        return yield* Effect.fail(
          new InvalidRequest({
            message: "Missing filename for ${filename} key",
          }),
        );
      }
      const config = yield* HeraldConfig;
      const materializedOpt = config.lookupBucket(bucket);
      if (Option.isNone(materializedOpt)) {
        return yield* Effect.fail(
          new NoSuchBucket({
            bucket,
            message: "The specified bucket does not exist",
          }),
        );
      }
      const materialized = materializedOpt.value;
      const accessKeyId = field("AWSAccessKeyId") ??
        fields["x-amz-credential"]?.split("/")[0];
      if (!accessKeyId) {
        return yield* Effect.fail(
          new AccessDenied({ message: "Access Denied" }),
        );
      }
      const signature = signatureVal;
      if (!signature) {
        return yield* Effect.fail(
          new AccessDenied({ message: "Access Denied" }),
        );
      }
      const policy = yield* parsePolicyJson(policyB64);
      // Normalize form keys to lowercase for condition matching (S3 allows case-insensitive field names)
      const fieldsNorm: Record<string, string> = {};
      for (const [k, v] of Object.entries(fields)) {
        fieldsNorm[k.toLowerCase()] = v;
      }
      // When key is ${filename}, validate policy against the resolved key so starts-with "foo" matches "foo.txt"
      const fieldsForValidation = objectKey !== keyFromForm.trim()
        ? { ...fieldsNorm, key: objectKey }
        : fieldsNorm;
      yield* validatePolicyConditions(
        policy,
        bucket,
        fieldsForValidation,
        filePart.body.length,
      );
      // Resolve secret: use proxy auth (resolveAuth) first so Swift and multi-user configs work
      let secretOpt = Option.none<string>();
      const authCreds = config.resolveAuth(bucket);
      if (Option.isSome(authCreds)) {
        const cred = authCreds.value.find(
          (c) => c.accessKeyId === accessKeyId,
        );
        if (cred?.secretAccessKey) {
          secretOpt = Option.some(cred.secretAccessKey);
        }
      }
      if (Option.isNone(secretOpt)) {
        secretOpt = getSecretForAccessKey(
          materialized.credentials,
          accessKeyId,
        );
      }
      if (Option.isNone(secretOpt)) {
        return yield* Effect.fail(
          new AccessDenied({ message: "Access Denied" }),
        );
      }
      yield* verifyPolicySignatureV2(
        policyB64,
        signature,
        secretOpt.value,
      );
      const headerService = yield* S3HeaderService;
      const putHeaders = headerService.formFieldsToPutHeaders(
        fieldsNorm,
        filePart.body.length,
      );
      const result = yield* backend.putObject(
        objectKey,
        Stream.fromIterable([filePart.body]),
        putHeaders,
      );
      const successActionStatus = field("success_action_status");
      if (successActionStatus === "201") {
        const baseUrl = request.url.startsWith("http")
          ? new URL(request.url).origin
          : `http://${request.headers["host"] ?? "localhost"}`;
        const location = `${baseUrl}/${bucket}/${
          encodeURIComponent(objectKey)
        }`;
        return s3Xml.formatPostResponse({
          location,
          bucket,
          key: objectKey,
          etag: result.etag ?? "",
        });
      }
      if (successActionStatus === "200") {
        return HttpServerResponse.empty({ status: 200 });
      }
      yield* Effect.logDebug("PostObject: success, returning 204");
      return HttpServerResponse.empty({ status: 204 });
    }
    if (policyB64 && !hasSignature) {
      return yield* Effect.fail(
        new InvalidRequest({ message: "Missing signature in form" }),
      );
    }
    yield* Effect.logDebug(
      `PostObject: no policy or signature in form (policy=${!!policyB64} signature=${hasSignature}), falling through`,
    );
  }

  return yield* Effect.fail(
    new Error(`Method POST not implemented for this request`),
  );
});
