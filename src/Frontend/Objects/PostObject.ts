/**
 * S3 PostObject: policy document shape and condition matching.
 * Policy is base64-encoded JSON with "expiration" and "conditions".
 */

import { Effect, Option } from "effect";
import { createHmac } from "node-crypto";
import { AccessDenied, InvalidRequest } from "../../Services/Backend.ts";
import type { MaterializedBucket } from "../../Domain/Config.ts";

export interface PostObjectPolicy {
  readonly expiration: string;
  readonly conditions: readonly PostObjectCondition[];
}

export type PostObjectCondition =
  | { readonly type: "eq"; key: string; value: string }
  | { readonly type: "starts-with"; key: string; value: string }
  | { readonly type: "content-length-range"; min: number; max: number };

export function parsePolicyJson(raw: string): Effect.Effect<
  PostObjectPolicy,
  InvalidRequest | AccessDenied
> {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => atob(raw),
      catch: () =>
        new InvalidRequest({ message: "Policy is not valid base64" }),
    });
    const parsed = yield* Effect.try({
      try: () => JSON.parse(decoded) as Record<string, unknown>,
      catch: () => new InvalidRequest({ message: "Policy is not valid JSON" }),
    });
    if (!("expiration" in parsed) || !("conditions" in parsed)) {
      return yield* Effect.fail(
        new InvalidRequest({
          message: "Policy must contain expiration and conditions",
        }),
      );
    }
    if (
      typeof parsed.expiration !== "string" ||
      !Array.isArray(parsed.conditions)
    ) {
      return yield* Effect.fail(
        new InvalidRequest({
          message: "Policy must contain expiration and conditions",
        }),
      );
    }
    const conditions: PostObjectCondition[] = [];
    for (const c of parsed.conditions) {
      if (typeof c === "object" && c !== null && Array.isArray(c)) {
        const [op, key, value] = c as [string, string, unknown];
        if (
          op === "starts-with" && typeof key === "string" &&
          typeof value === "string"
        ) {
          conditions.push({ type: "starts-with", key, value });
        } else if (
          op === "eq" && typeof key === "string" && typeof value === "string"
        ) {
          conditions.push({ type: "eq", key, value });
        } else if (
          op === "content-length-range" && Array.isArray(c) && c.length >= 3
        ) {
          const min = Number((c as [string, number, number])[1]);
          const max = Number((c as [string, number, number])[2]);
          if (!Number.isNaN(min) && !Number.isNaN(max)) {
            conditions.push({ type: "content-length-range", min, max });
          }
        }
      } else if (typeof c === "object" && c !== null && !Array.isArray(c)) {
        const obj = c as Record<string, string>;
        const keys = Object.keys(obj);
        if (keys.length === 1) {
          const k = keys[0];
          const v = obj[k];
          if (typeof v === "string") {
            conditions.push({ type: "eq", key: k, value: v });
          }
        }
      }
    }
    return {
      expiration: parsed.expiration as string,
      conditions,
    };
  });
}

function getSecretForAccessKey(
  credentials: MaterializedBucket["credentials"],
  accessKeyId: string,
): Option.Option<string> {
  if (!credentials) return Option.none();
  if ("accessKeyId" in credentials && credentials.accessKeyId === accessKeyId) {
    return credentials.secretAccessKey
      ? Option.some(credentials.secretAccessKey)
      : Option.none();
  }
  if ("username" in credentials && credentials.username === accessKeyId) {
    return credentials.password
      ? Option.some(credentials.password)
      : Option.none();
  }
  return Option.none();
}

export function validatePolicyConditions(
  policy: PostObjectPolicy,
  bucket: string,
  fields: Record<string, string>,
  fileSize: number,
): Effect.Effect<void, AccessDenied | InvalidRequest> {
  return Effect.gen(function* () {
    const expDate = new Date(policy.expiration);
    if (Number.isNaN(expDate.getTime())) {
      return yield* Effect.fail(
        new AccessDenied({ message: "Invalid policy expiration date" }),
      );
    }
    if (expDate.getTime() <= Date.now()) {
      return yield* Effect.fail(
        new AccessDenied({ message: "Policy has expired" }),
      );
    }

    // Case-insensitive form field lookup (caller may pass normalized lowercase keys)
    const getField = (key: string) =>
      fields[key.toLowerCase()] ?? fields[key] ?? "";

    for (const c of policy.conditions) {
      if (c.type === "eq") {
        const keyLower = c.key.toLowerCase();
        if (keyLower === "bucket") {
          if (c.value !== bucket) {
            return yield* Effect.fail(
              new AccessDenied({
                message: "Policy bucket does not match request",
              }),
            );
          }
          continue;
        }
        const formKey = c.key.startsWith("$") ? c.key.slice(1) : c.key;
        const formValue = getField(formKey);
        const expected = c.value;
        const actual = formValue ?? "";
        if (
          actual !== expected && actual.toLowerCase() !== expected.toLowerCase()
        ) {
          return yield* Effect.fail(
            new AccessDenied({
              message: `Policy condition failed: ${c.key} must be ${expected}`,
            }),
          );
        }
      } else if (c.type === "starts-with") {
        const formKey = c.key.startsWith("$") ? c.key.slice(1) : c.key;
        const formValue = getField(formKey);
        const prefix = c.value;
        if (formKey.toLowerCase() === "key") {
          if (!formValue.startsWith(prefix)) {
            return yield* Effect.fail(
              new AccessDenied({
                message:
                  `Policy condition failed: key must start with ${prefix}`,
              }),
            );
          }
        } else if (formKey.toLowerCase() === "content-type") {
          if (!formValue.toLowerCase().startsWith(prefix.toLowerCase())) {
            return yield* Effect.fail(
              new AccessDenied({
                message:
                  `Policy condition failed: Content-Type must start with ${prefix}`,
              }),
            );
          }
        }
      } else if (c.type === "content-length-range") {
        if (fileSize < c.min || fileSize > c.max) {
          return yield* Effect.fail(
            new AccessDenied({
              message:
                `Policy condition failed: content-length-range ${c.min}-${c.max}`,
            }),
          );
        }
      }
    }

    // Strict policy: every form field must appear in the policy (S3/MinIO/s3-tests)
    const allowedKeys = new Set<string>([
      "policy",
      "signature",
      "awsaccesskeyid",
      "x-amz-signature",
      "file",
    ]);
    const allowedPrefixes: string[] = [];
    for (const c of policy.conditions) {
      if (c.type === "eq" || c.type === "starts-with") {
        const formKey = c.key.startsWith("$") ? c.key.slice(1) : c.key;
        const formKeyLower = formKey.toLowerCase();
        if (formKeyLower !== "bucket") {
          allowedKeys.add(formKeyLower);
          if (c.type === "starts-with" && c.value === "") {
            allowedPrefixes.push(formKeyLower);
          }
        }
      }
    }
    for (const key of Object.keys(fields)) {
      const keyLower = key.toLowerCase();
      if (allowedKeys.has(keyLower)) continue;
      if (allowedPrefixes.some((p) => keyLower.startsWith(p))) continue;
      // Allow x-amz-checksum-* without requiring them in the policy (s3-tests, reliability)
      if (keyLower.startsWith("x-amz-checksum-")) continue;
      return yield* Effect.fail(
        new AccessDenied({
          message:
            `Each form field that you specify in a form must appear in the list of policy conditions. "${key}" not specified in the policy.`,
        }),
      );
    }
  });
}

/**
 * Verify PostObject policy signature (HMAC-SHA1 of base64 policy).
 * Caller must resolve the secret (e.g. from resolveAuth or backend credentials).
 */
export function verifyPolicySignatureV2(
  policyBase64: string,
  signatureBase64: string,
  secret: string,
): Effect.Effect<void, AccessDenied> {
  return Effect.gen(function* () {
    const expectedSig = yield* Effect.try({
      try: () =>
        createHmac("sha1", secret)
          .update(policyBase64, "utf8")
          .digest("base64"),
      catch: () => new AccessDenied({ message: "Access Denied" }),
    });
    if (expectedSig !== signatureBase64) {
      return yield* Effect.fail(
        new AccessDenied({ message: "Access Denied" }),
      );
    }
  });
}

export { getSecretForAccessKey };
