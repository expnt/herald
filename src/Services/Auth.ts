import { Effect, Either, Schema } from "effect";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256";
// deno-lint-ignore no-external-import
import { timingSafeEqual } from "node:crypto";
import type { HttpRequest } from "@smithy/types";
import type { HttpServerRequest } from "@effect/platform";

export const AuthCredentials = Schema.Struct({
  accessKeyId: Schema.String,
  secretAccessKey: Schema.String,
});

export type AuthCredentials = Schema.Schema.Type<typeof AuthCredentials>;

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  message: Schema.String,
}) {}

/**
 * Resolves authentication credentials from environment variables based on refs.
 */
export function resolveAuthCredentials(
  refs: readonly string[],
  env: Record<string, string>,
): AuthCredentials[] {
  const credentials: AuthCredentials[] = [];
  for (const ref of refs) {
    const accessKeyId = env[`HERALD_AUTH_${ref.toUpperCase()}_ACCESS_KEY_ID`];
    const secretAccessKey = env[`HERALD_AUTH_${ref.toUpperCase()}_SECRET_KEY`];
    if (accessKeyId && secretAccessKey) {
      credentials.push({ accessKeyId, secretAccessKey });
    }
  }
  return credentials;
}

/**
 * Verifies a SigV4 signature for an incoming request.
 */
export function verifyIncomingSigV4(
  request: HttpServerRequest.HttpServerRequest,
  credentials: AuthCredentials[],
  region: string,
): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    if (credentials.length === 0) {
      return false;
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers)) {
      if (typeof v === "string") {
        headers[k.toLowerCase()] = v;
      }
    }

    const host = headers["host"] || "localhost";
    const protocol = request.url.startsWith("https") ? "https:" : "http:";
    const url = new URL(request.url, `${protocol}//${host}`);
    const queryParams = url.searchParams;
    const hasSigInQuery = queryParams.has("X-Amz-Signature");

    const authHeader = headers["authorization"];
    if (!authHeader && !hasSigInQuery) {
      return false;
    }

    let requestAccessKeyId: string | undefined;
    let signedHeadersList: string[] = [];
    let headerRegion: string | undefined;

    if (authHeader?.startsWith("AWS4-HMAC-SHA256")) {
      const match = authHeader.match(/Credential=([^, ]+)/);
      if (match && match[1]) {
        const parts = match[1].split("/");
        requestAccessKeyId = parts[0];
        if (parts.length >= 4) {
          headerRegion = parts[2];
        }
      }

      const headersMatch = authHeader.match(/SignedHeaders=([^, ]+)/);
      if (headersMatch && headersMatch[1]) {
        signedHeadersList = headersMatch[1].split(";");
      }
    } else if (hasSigInQuery) {
      const credential = queryParams.get("X-Amz-Credential");
      if (credential && typeof credential === "string") {
        const parts = credential.split("/");
        requestAccessKeyId = parts[0];
        if (parts.length >= 4) {
          headerRegion = parts[2];
        }
      }

      const signedHeaders = queryParams.get("X-Amz-SignedHeaders");
      if (signedHeaders && typeof signedHeaders === "string") {
        signedHeadersList = signedHeaders.split(";");
      }
    }

    if (!requestAccessKeyId) {
      return false;
    }

    // Use region from header if available, otherwise use provided region
    const effectiveRegion = headerRegion ?? region;

    const matchingCreds = credentials.filter(
      (c) => c.accessKeyId === requestAccessKeyId,
    );
    if (matchingCreds.length === 0) {
      return false;
    }

    // Filter headers to only those that were signed
    const filteredHeaders: Record<string, string> = {};
    for (const h of signedHeadersList) {
      const val = headers[h];
      if (val !== undefined) {
        filteredHeaders[h] = val;
      }
    }

    const encoder = new TextEncoder();

    for (const cred of matchingCreds) {
      const signer = new SignatureV4({
        credentials: {
          accessKeyId: cred.accessKeyId,
          secretAccessKey: cred.secretAccessKey,
        },
        region: effectiveRegion,
        service: "s3",
        sha256: Sha256,
      });

      // Extract signing date from request if possible
      const amzDate = headers["x-amz-date"];
      const dateHeader = headers["date"];
      let signingDate: Date | undefined;

      if (amzDate) {
        // format: YYYYMMDDTHHMMSSZ
        const year = amzDate.substring(0, 4);
        const month = amzDate.substring(4, 6);
        const day = amzDate.substring(6, 8);
        const hour = amzDate.substring(9, 11);
        const min = amzDate.substring(11, 13);
        const sec = amzDate.substring(13, 15);
        signingDate = new Date(
          `${year}-${month}-${day}T${hour}:${min}:${sec}Z`,
        );
      } else if (dateHeader) {
        signingDate = new Date(dateHeader);
      } else if (hasSigInQuery) {
        const amzDateQuery = queryParams.get("X-Amz-Date");
        if (amzDateQuery && typeof amzDateQuery === "string") {
          const year = amzDateQuery.substring(0, 4);
          const month = amzDateQuery.substring(4, 6);
          const day = amzDateQuery.substring(6, 8);
          const hour = amzDateQuery.substring(9, 11);
          const min = amzDateQuery.substring(11, 13);
          const sec = amzDateQuery.substring(13, 15);
          signingDate = new Date(
            `${year}-${month}-${day}T${hour}:${min}:${sec}Z`,
          );
        }
      }

      if (signingDate && isNaN(signingDate.getTime())) {
        signingDate = undefined;
      }

      // Convert query params to smithy format (Record<string, string | string[]>)
      const queryBag: Record<string, string | string[]> = {};
      queryParams.forEach((v, k) => {
        const existing = queryBag[k];
        if (existing !== undefined) {
          if (Array.isArray(existing)) {
            existing.push(v);
          } else {
            queryBag[k] = [existing, v];
          }
        } else {
          queryBag[k] = v;
        }
      });

      const signableReq: HttpRequest = {
        method: request.method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? parseInt(url.port) : undefined,
        path: url.pathname,
        query: queryBag,
        headers: filteredHeaders,
      };

      const signedResult = yield* Effect.tryPromise({
        try: async () => {
          return await signer.sign(signableReq, {
            signingDate,
          });
        },
        catch: (e) => e,
      }).pipe(Effect.either);

      if (Either.isLeft(signedResult)) {
        continue;
      }
      const signed = signedResult.right;

      if (authHeader) {
        const expectedAuth = signed.headers["authorization"];
        if (
          !expectedAuth || typeof expectedAuth !== "string" ||
          authHeader.length !== expectedAuth.length
        ) {
          continue;
        }
        const isValid = timingSafeEqual(
          encoder.encode(authHeader),
          encoder.encode(expectedAuth),
        );
        if (isValid) return true;
      } else {
        const expectedSig = (signed.query as Record<string, string | string[]>)[
          "X-Amz-Signature"
        ];
        const actualSig = queryParams.get("X-Amz-Signature");
        if (
          !actualSig || !expectedSig || typeof expectedSig !== "string" ||
          actualSig.length !== expectedSig.length
        ) {
          continue;
        }
        const isValid = timingSafeEqual(
          encoder.encode(actualSig),
          encoder.encode(expectedSig),
        );
        if (isValid) return true;
      }
    }

    return false;
  });
}
