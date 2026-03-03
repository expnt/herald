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

export type SigV4ValidationFailure =
  | "MissingCredentials"
  | "MissingRegion"
  | "MalformedAuthorization"
  | "UnknownAccessKey"
  | "MissingDate"
  | "InvalidDate"
  | "InvalidExpires"
  | "ExpiredPresign"
  | "PresignNotYetValid"
  | "PresignExpiresTooLong"
  | "RequestTimeTooSkewed"
  | "InvalidSignature";

export type SigV4ValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly failure: SigV4ValidationFailure };

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
  return verifyIncomingSigV4Detailed(request, credentials, region).pipe(
    Effect.map((result) => result.valid),
  );
}

function parseSigV4Date(rawDate: string): Date | undefined {
  // SigV4 format: YYYYMMDDTHHMMSSZ
  if (/^\d{8}T\d{6}Z$/.test(rawDate)) {
    const year = rawDate.substring(0, 4);
    const month = rawDate.substring(4, 6);
    const day = rawDate.substring(6, 8);
    const hour = rawDate.substring(9, 11);
    const min = rawDate.substring(11, 13);
    const sec = rawDate.substring(13, 15);
    const parsed = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}Z`);
    return isNaN(parsed.getTime()) ? undefined : parsed;
  }

  // AWS2 and some clients send RFC 1123 dates in x-amz-date/date.
  const parsed = new Date(rawDate);
  return isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Verifies a SigV4 signature for an incoming request and returns a failure
 * reason that can be mapped to S3-compatible XML error codes.
 */
export function verifyIncomingSigV4Detailed(
  request: HttpServerRequest.HttpServerRequest,
  credentials: AuthCredentials[],
  region: string,
): Effect.Effect<SigV4ValidationResult, never> {
  return Effect.gen(function* () {
    if (credentials.length === 0) {
      return { valid: false, failure: "UnknownAccessKey" } as const;
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

    const rawAuthorization = headers["authorization"];
    const authHeader = rawAuthorization !== undefined &&
        rawAuthorization.trim() !== ""
      ? rawAuthorization
      : undefined;
    if (authHeader === undefined && !hasSigInQuery) {
      return { valid: false, failure: "MissingCredentials" } as const;
    }

    let requestAccessKeyId: string | undefined;
    let credentialDate: string | undefined;
    let credentialService: string | undefined;
    let signedHeadersList: string[] = [];
    let headerRegion: string | undefined;

    if (authHeader?.startsWith("AWS4-HMAC-SHA256")) {
      const match = authHeader.match(/Credential=([^, ]+)/);
      if (match && match[1]) {
        const parts = match[1].split("/");
        requestAccessKeyId = parts[0];
        if (parts.length >= 5) {
          credentialDate = parts[1];
          headerRegion = parts[2];
          credentialService = parts[3];
        }
      }

      const headersMatch = authHeader.match(/SignedHeaders=([^, ]+)/);
      if (headersMatch && headersMatch[1]) {
        signedHeadersList = headersMatch[1].split(";");
      }
    } else if (authHeader !== undefined && !hasSigInQuery) {
      return { valid: false, failure: "MalformedAuthorization" } as const;
    } else if (hasSigInQuery) {
      const algorithm = queryParams.get("X-Amz-Algorithm");
      if (algorithm !== "AWS4-HMAC-SHA256") {
        return { valid: false, failure: "MalformedAuthorization" } as const;
      }

      const credential = queryParams.get("X-Amz-Credential");
      if (credential && typeof credential === "string") {
        const parts = credential.split("/");
        requestAccessKeyId = parts[0];
        if (parts.length >= 5) {
          credentialDate = parts[1];
          headerRegion = parts[2];
          credentialService = parts[3];
        }
      }

      const signedHeaders = queryParams.get("X-Amz-SignedHeaders");
      if (signedHeaders && typeof signedHeaders === "string") {
        signedHeadersList = signedHeaders.split(";");
      }

      const dateParam = queryParams.get("X-Amz-Date");
      const expiresParam = queryParams.get("X-Amz-Expires");
      const signatureParam = queryParams.get("X-Amz-Signature");
      if (
        dateParam === null || expiresParam === null || signatureParam === null
      ) {
        return { valid: false, failure: "MalformedAuthorization" } as const;
      }
    }

    if (!requestAccessKeyId) {
      return { valid: false, failure: "MalformedAuthorization" } as const;
    }
    if (!credentialDate || !credentialService) {
      return { valid: false, failure: "MalformedAuthorization" } as const;
    }

    // Use region from header if available, otherwise use provided region
    const effectiveRegion = headerRegion ?? region;
    if (!effectiveRegion || effectiveRegion.trim() === "") {
      return { valid: false, failure: "MissingRegion" } as const;
    }

    const matchingCreds = credentials.filter(
      (c) => c.accessKeyId === requestAccessKeyId,
    );
    if (matchingCreds.length === 0) {
      return { valid: false, failure: "UnknownAccessKey" } as const;
    }

    const encoder = new TextEncoder();

    for (const cred of matchingCreds) {
      // Extract signing date from request if possible
      const amzDate = headers["x-amz-date"];
      const dateHeader = headers["date"];
      let signingDate: Date | undefined;

      if (hasSigInQuery) {
        const amzDateQuery = queryParams.get("X-Amz-Date");
        signingDate = amzDateQuery ? parseSigV4Date(amzDateQuery) : undefined;
      } else if (amzDate) {
        signingDate = parseSigV4Date(amzDate);
      } else if (dateHeader) {
        signingDate = parseSigV4Date(dateHeader);
      }

      // Validate signingDate: reject if missing or outside allowed windows
      if (!signingDate) {
        return {
          valid: false,
          failure: amzDate || dateHeader || queryParams.get("X-Amz-Date")
            ? "InvalidDate"
            : "MissingDate",
        } as const;
      }

      const now = new Date();
      const timeDiffMs = Math.abs(now.getTime() - signingDate.getTime());
      const timeDiffMinutes = timeDiffMs / (1000 * 60);

      if (hasSigInQuery) {
        // For query-presigned requests: validate X-Amz-Expires
        const expiresParam = queryParams.get("X-Amz-Expires");
        if (!expiresParam) {
          return { valid: false, failure: "InvalidExpires" } as const;
        }

        // Type-check X-Amz-Expires: must be a valid integer
        const expires = parseInt(expiresParam, 10);
        if (isNaN(expires) || expiresParam !== String(expires) || expires < 0) {
          return { valid: false, failure: "InvalidExpires" } as const;
        }

        // AWS SigV4 presigned URLs support at most 7 days.
        if (expires > 604800) {
          return { valid: false, failure: "PresignExpiresTooLong" } as const;
        }

        // Reject if expired: now > signingDate + expires
        const expirationTime = new Date(signingDate.getTime() + expires * 1000);
        if (now > expirationTime) {
          return { valid: false, failure: "ExpiredPresign" } as const;
        }

        // Presigned requests from the future are also invalid.
        const nowWithSkew = new Date(now.getTime() + 15 * 60 * 1000);
        if (nowWithSkew < signingDate) {
          return { valid: false, failure: "PresignNotYetValid" } as const;
        }
      } else {
        // For header-signed requests: enforce ±15 minutes clock skew
        if (timeDiffMinutes > 15) {
          return { valid: false, failure: "RequestTimeTooSkewed" } as const;
        }
      }

      // Filter headers to only those that were signed
      const filteredHeaders: Record<string, string> = {};
      for (const h of signedHeadersList) {
        const val = headers[h];
        if (val !== undefined) {
          filteredHeaders[h] = val;
        }
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
      if (hasSigInQuery) {
        delete queryBag["X-Amz-Signature"];
      }

      // Use raw path from request.url to avoid URL constructor decoding
      const urlString = request.url;
      const queryIndex = urlString.indexOf("?");
      const withoutQuery = queryIndex === -1
        ? urlString
        : urlString.substring(0, queryIndex);
      const rawPath = withoutQuery.replace(/^[a-z]+:\/\/[^/]+/, "");

      const signableReq: HttpRequest = {
        method: request.method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? parseInt(url.port) : undefined,
        path: rawPath,
        query: queryBag,
        headers: filteredHeaders,
      };

      const signer = new SignatureV4({
        credentials: {
          accessKeyId: cred.accessKeyId,
          secretAccessKey: cred.secretAccessKey,
        },
        region: effectiveRegion,
        service: "s3",
        sha256: Sha256,
        uriEscapePath: false,
      });

      const signedResult = yield* Effect.tryPromise({
        try: async () =>
          await signer.sign(signableReq, {
            signingDate,
            signableHeaders: new Set(signedHeadersList),
          }),
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
        if (isValid) return { valid: true } as const;
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
        if (isValid) return { valid: true } as const;
      }
    }

    return { valid: false, failure: "InvalidSignature" } as const;
  });
}
