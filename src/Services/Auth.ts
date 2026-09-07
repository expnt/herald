import { Effect, Either, Schema } from "effect";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256";
// deno-lint-ignore no-external-import
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
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

export interface SigV4VerifiedContext {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly scopeDate: string;
  readonly scopeRegion: string;
  readonly scopeService: string;
  readonly amzDate: string;
  readonly initialSignature: string;
  readonly signedHeaders: readonly string[];
  readonly isPresigned: boolean;
}

export type SigV4ValidationResult =
  | { readonly valid: true; readonly context: SigV4VerifiedContext }
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
    const upper = ref.toUpperCase();
    const accessKeyId = env[`HERALD_AUTH_${upper}_ACCESS_KEY_ID`];
    const secretAccessKey = env[`HERALD_AUTH_${upper}_SECRET_KEY`];
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

const rfc3986Encode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const normalizeHeaderValue = (value: string): string =>
  value.trim().replace(/\s+/g, " ");

const canonicalizeQueryWithoutSignature = (
  queryParams: URLSearchParams,
): string => {
  const pairs: Array<readonly [string, string]> = [];
  queryParams.forEach((value, key) => {
    if (key === "X-Amz-Signature") {
      return;
    }
    pairs.push([rfc3986Encode(key), rfc3986Encode(value)]);
  });

  pairs.sort(([aKey, aValue], [bKey, bValue]) => {
    if (aKey < bKey) return -1;
    if (aKey > bKey) return 1;
    if (aValue < bValue) return -1;
    if (aValue > bValue) return 1;
    return 0;
  });

  return pairs.map(([key, value]) => `${key}=${value}`).join("&");
};

const deriveSigV4SigningKey = (
  secretAccessKey: string,
  credentialDate: string,
  region: string,
  service: string,
): Uint8Array => {
  const kDate = createHmac("sha256", `AWS4${secretAccessKey}`)
    .update(credentialDate)
    .digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update(service).digest();
  return createHmac("sha256", kService).update("aws4_request").digest();
};

const computeS3PresignedSignature = (options: {
  readonly method: string;
  readonly rawPath: string;
  readonly queryParams: URLSearchParams;
  readonly signedHeaders: readonly string[];
  readonly headers: Readonly<Record<string, string>>;
  readonly amzDate: string;
  readonly credentialDate: string;
  readonly region: string;
  readonly service: string;
  readonly secretAccessKey: string;
}): string | undefined => {
  const sortedSignedHeaders = [...options.signedHeaders]
    .map((headerName) => headerName.toLowerCase())
    .sort();

  const canonicalHeaderLines: string[] = [];
  for (const headerName of sortedSignedHeaders) {
    const value = options.headers[headerName];
    if (value === undefined) {
      return undefined;
    }
    canonicalHeaderLines.push(`${headerName}:${normalizeHeaderValue(value)}`);
  }

  const canonicalHeaders = `${canonicalHeaderLines.join("\n")}\n`;
  const signedHeadersString = sortedSignedHeaders.join(";");
  const canonicalQuery = canonicalizeQueryWithoutSignature(options.queryParams);
  const canonicalPath = options.rawPath === "" ? "/" : options.rawPath;
  const canonicalRequest = [
    options.method.toUpperCase(),
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeadersString,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const canonicalRequestHash = createHash("sha256")
    .update(canonicalRequest)
    .digest("hex");
  const credentialScope =
    `${options.credentialDate}/${options.region}/${options.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    options.amzDate,
    credentialScope,
    canonicalRequestHash,
  ].join("\n");
  const signingKey = deriveSigV4SigningKey(
    options.secretAccessKey,
    options.credentialDate,
    options.region,
    options.service,
  );
  return createHmac("sha256", signingKey).update(stringToSign).digest("hex");
};

/**
 * Hand-rolled header-based SigV4 signature. Used instead of the smithy signer
 * whenever the request's x-amz-content-sha256 is a SigV4 streaming sentinel
 * (STREAMING-AWS4-HMAC-SHA256-PAYLOAD, STREAMING-UNSIGNED-PAYLOAD-TRAILER,
 * UNSIGNED-PAYLOAD): per spec the canonical request then carries the sentinel
 * LITERALLY as the payload hash, while a body-hashing signer would compute
 * sha256(body) and never match clients that stream/chunk their uploads
 * (kopia's S3 client sends the sentinel without Content-Encoding: aws-chunked,
 * which is why this path exists).
 */
export const computeS3HeaderSignature = (options: {
  readonly method: string;
  readonly rawPath: string;
  readonly signedHeaders: readonly string[];
  readonly queryParams: Readonly<URLSearchParams>;
  readonly headers: Readonly<Record<string, string>>;
  readonly amzDate: string;
  readonly credentialDate: string;
  readonly region: string;
  readonly service: string;
  readonly secretAccessKey: string;
  readonly payloadHash: string;
}): string | undefined => {
  const sortedSignedHeaders = [...options.signedHeaders]
    .map((headerName) => headerName.toLowerCase())
    .sort();

  const canonicalHeaderLines: string[] = [];
  for (const headerName of sortedSignedHeaders) {
    const value = options.headers[headerName];
    if (value === undefined) {
      return undefined;
    }
    canonicalHeaderLines.push(`${headerName}:${normalizeHeaderValue(value)}`);
  }

  const canonicalHeaders = `${canonicalHeaderLines.join("\n")}\n`;
  const signedHeadersString = sortedSignedHeaders.join(";");
  const canonicalPath = options.rawPath === "" ? "/" : options.rawPath;
  const canonicalRequest = [
    options.method.toUpperCase(),
    canonicalPath,
    canonicalizeQueryWithoutSignature(options.queryParams),
    canonicalHeaders,
    signedHeadersString,
    options.payloadHash,
  ].join("\n");

  const canonicalRequestHash = createHash("sha256")
    .update(canonicalRequest)
    .digest("hex");
  const credentialScope =
    `${options.credentialDate}/${options.region}/${options.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    options.amzDate,
    credentialScope,
    canonicalRequestHash,
  ].join("\n");
  const signingKey = deriveSigV4SigningKey(
    options.secretAccessKey,
    options.credentialDate,
    options.region,
    options.service,
  );
  return createHmac("sha256", signingKey).update(stringToSign).digest("hex");
};

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
    const rawHeaders = request.headers as Record<string, unknown>;
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (typeof v === "string") {
        headers[k.toLowerCase()] = v;
      } else if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") {
        headers[k.toLowerCase()] = v[0];
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
    let parsedHeaderSignature: string | undefined;

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
      const signatureMatch = authHeader.match(/Signature=([0-9a-fA-F]+)/);
      if (signatureMatch && signatureMatch[1]) {
        parsedHeaderSignature = signatureMatch[1].toLowerCase();
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
        if (isNaN(expires) || expiresParam !== String(expires)) {
          return { valid: false, failure: "InvalidExpires" } as const;
        }

        // AWS treats non-positive presign TTL as expired requests.
        if (expires <= 0) {
          return { valid: false, failure: "ExpiredPresign" } as const;
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

      if (hasSigInQuery) {
        const amzDateFromQuery = queryParams.get("X-Amz-Date");
        const actualSig = queryParams.get("X-Amz-Signature");
        if (amzDateFromQuery === null || actualSig === null) {
          continue;
        }

        const expectedSig = computeS3PresignedSignature({
          method: request.method,
          rawPath,
          queryParams,
          signedHeaders: signedHeadersList,
          headers: filteredHeaders,
          amzDate: amzDateFromQuery,
          credentialDate,
          region: effectiveRegion,
          service: credentialService,
          secretAccessKey: cred.secretAccessKey,
        });
        if (
          expectedSig === undefined || actualSig.length !== expectedSig.length
        ) {
          continue;
        }

        const isValid = timingSafeEqual(
          encoder.encode(actualSig.toLowerCase()),
          encoder.encode(expectedSig),
        );
        if (isValid) {
          return {
            valid: true,
            context: {
              accessKeyId: cred.accessKeyId,
              secretAccessKey: cred.secretAccessKey,
              scopeDate: credentialDate,
              scopeRegion: effectiveRegion,
              scopeService: credentialService,
              amzDate: amzDateFromQuery,
              initialSignature: actualSig.toLowerCase(),
              signedHeaders: [...signedHeadersList],
              isPresigned: true,
            },
          } as const;
        }
        continue;
      }

      const payloadHashHeader = headers["x-amz-content-sha256"]?.trim()
        .toUpperCase() ?? "";
      const isStreamingSentinel = payloadHashHeader.startsWith("STREAMING-") ||
        payloadHashHeader === "UNSIGNED-PAYLOAD";

      const expectedAuth = isStreamingSentinel
        ? undefined
        : yield* Effect.tryPromise({
          try: async () => {
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
            return await signer.sign(signableReq, {
              signingDate,
              signableHeaders: new Set(signedHeadersList),
            });
          },
          catch: (e) => e,
        }).pipe(
          Effect.either,
          Effect.map(
            (either): string | undefined =>
              Either.isRight(either)
                ? either.right.headers["authorization"]
                : undefined,
          ),
        );

      const sentinelSig = isStreamingSentinel
        ? computeS3HeaderSignature({
          method: request.method,
          payloadHash: payloadHashHeader, // sentinel must stay uppercase-literal per spec
          rawPath,
          signedHeaders: signedHeadersList,
          queryParams,
          headers: filteredHeaders,
          amzDate: headers["x-amz-date"] ?? "",
          credentialDate,
          region: effectiveRegion,
          service: credentialService,
          secretAccessKey: cred.secretAccessKey,
        })
        : undefined;

      const finalExpectedSig = expectedAuth !== undefined
        // smithy path: expectedAuth is the full Authorization header — compare
        // the trailing signature portion.
        ? expectedAuth.match(/Signature=([0-9a-fA-F]+)/)?.[1]?.toLowerCase()
        : sentinelSig;
      if (
        authHeader && finalExpectedSig && parsedHeaderSignature &&
        finalExpectedSig.length === parsedHeaderSignature.length
      ) {
        const isValid = timingSafeEqual(
          encoder.encode(parsedHeaderSignature),
          encoder.encode(finalExpectedSig),
        );
        if (isValid) {
          const initialSignature = parsedHeaderSignature;
          const amzDateFromRequest = headers["x-amz-date"] ??
            queryParams.get("X-Amz-Date") ??
            "";
          if (
            initialSignature === undefined ||
            amzDateFromRequest === ""
          ) {
            continue;
          }
          return {
            valid: true,
            context: {
              accessKeyId: cred.accessKeyId,
              secretAccessKey: cred.secretAccessKey,
              scopeDate: credentialDate,
              scopeRegion: effectiveRegion,
              scopeService: credentialService,
              amzDate: amzDateFromRequest,
              initialSignature,
              signedHeaders: [...signedHeadersList],
              isPresigned: false,
            },
          } as const;
        }
      }
    }

    return { valid: false, failure: "InvalidSignature" } as const;
  });
}

export type SigV2ValidationFailure =
  | "MalformedAuthorization"
  | "UnknownAccessKey"
  | "MissingDate"
  | "InvalidDate"
  | "RequestTimeTooSkewed"
  | "InvalidSignature";

export type SigV2ValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly failure: SigV2ValidationFailure };

/**
 * Query-string arguments that participate in the AWS Signature V2
 * canonical resource (mirrors botocore's HmacV1Auth.QSAOfInterest).
 */
const V2_QSA_OF_INTEREST = new Set([
  "accelerate",
  "acl",
  "cors",
  "defaultObjectAcl",
  "location",
  "logging",
  "partNumber",
  "policy",
  "requestPayment",
  "torrent",
  "versioning",
  "versionId",
  "versions",
  "website",
  "uploads",
  "uploadId",
  "response-content-type",
  "response-content-language",
  "response-expires",
  "response-cache-control",
  "response-content-disposition",
  "response-content-encoding",
  "delete",
  "lifecycle",
  "tagging",
  "restore",
  "storageClass",
  "notification",
  "replication",
  "analytics",
  "metrics",
  "inventory",
  "select",
  "select-type",
  "object-lock",
]);

const buildV2CanonicalResource = (url: URL): string => {
  let buf = url.pathname;
  if (url.search) {
    const qsa = url.search.slice(1).split("&")
      .map((pair) => {
        const eq = pair.indexOf("=");
        const key = eq === -1 ? pair : pair.slice(0, eq);
        const value = eq === -1 ? "" : pair.slice(eq + 1);
        return {
          key: decodeURIComponent(key),
          value: decodeURIComponent(value),
        };
      })
      .filter(({ key }) => V2_QSA_OF_INTEREST.has(key))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(({ key, value }) => `${key}=${value}`);
    if (qsa.length > 0) {
      buf += `?${qsa.join("&")}`;
    }
  }
  return buf;
};

/**
 * Builds the AWS Signature V2 (HmacV1) StringToSign exactly as botocore's
 * HmacV1Auth does: METHOD, Content-MD5, Content-Type, Date, canonicalized
 * x-amz-* headers, then the canonical resource.
 */
const buildV2StringToSign = (
  method: string,
  url: URL,
  headers: Record<string, string>,
): string => {
  const contentMd5 = headers["content-md5"]?.trim() ?? "";
  const contentType = headers["content-type"]?.trim() ?? "";
  const date = headers["date"]?.trim() ?? "";
  let cs = `${method.toUpperCase()}\n${contentMd5}\n${contentType}\n${date}\n`;
  const customHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.startsWith("x-amz-")) {
      customHeaders[key] = value.trim();
    }
  }
  const sortedKeys = Object.keys(customHeaders).sort();
  if (sortedKeys.length > 0) {
    cs += sortedKeys.map((k) => `${k}:${customHeaders[k]}`).join("\n") + "\n";
  }
  cs += buildV2CanonicalResource(url);
  return cs;
};

/**
 * Verifies an AWS Signature V2 (HmacV1) request. Date is validated before the
 * signature so that a bad x-amz-date surfaces as a date error rather than a
 * signature mismatch (matching S3 behavior).
 */
export function verifyIncomingSigV2(
  request: HttpServerRequest.HttpServerRequest,
  credentials: AuthCredentials[],
): SigV2ValidationResult {
  const headers: Record<string, string> = {};
  const rawHeaders = request.headers as Record<string, unknown>;
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (typeof v === "string") {
      headers[k.toLowerCase()] = v;
    } else if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") {
      headers[k.toLowerCase()] = v[0];
    }
  }

  const rawAuthorization = headers["authorization"];
  if (rawAuthorization === undefined) {
    return { valid: false, failure: "MalformedAuthorization" } as const;
  }
  const match = rawAuthorization.match(/^AWS\s+([^:]+):(.+)$/);
  if (!match) {
    return { valid: false, failure: "MalformedAuthorization" } as const;
  }
  const accessKeyId = match[1];
  const signature = match[2];

  const cred = credentials.find((c) => c.accessKeyId === accessKeyId);
  if (!cred) {
    return { valid: false, failure: "UnknownAccessKey" } as const;
  }

  // Date validation: prefer x-amz-date, fall back to Date.
  const dateRaw = headers["x-amz-date"] ?? headers["date"];
  if (dateRaw === undefined || dateRaw.trim() === "") {
    return { valid: false, failure: "MissingDate" } as const;
  }
  const signingDate = new Date(dateRaw);
  if (isNaN(signingDate.getTime()) || signingDate.getTime() < 0) {
    return { valid: false, failure: "InvalidDate" } as const;
  }
  const now = new Date();
  const timeDiffMinutes = Math.abs(now.getTime() - signingDate.getTime()) /
    (1000 * 60);
  if (timeDiffMinutes > 15) {
    return { valid: false, failure: "RequestTimeTooSkewed" } as const;
  }

  const host = headers["host"] || "localhost";
  const protocol = request.url.startsWith("https") ? "https:" : "http:";
  const url = new URL(request.url, `${protocol}//${host}`);
  const stringToSign = buildV2StringToSign(request.method, url, headers);
  const expected = createHmac("sha1", cred.secretAccessKey)
    .update(stringToSign)
    .digest("base64");
  if (expected !== signature) {
    return { valid: false, failure: "InvalidSignature" } as const;
  }
  return { valid: true } as const;
}
