import { HttpRequest, QueryParameterBag } from "@smithy/types";
import { Sha256 } from "@aws-crypto/sha256";
import * as s from "@smithy/signature-v4";
import { AMZ_DATE_HEADER, AUTH_HEADER } from "../constants/headers.ts";
import { APIErrors, getAPIErrorResponse } from "../types/api_errors.ts";
import { HeraldError } from "../types/http-exception.ts";
import { S3Config, SwiftConfig } from "../config/types.ts";
import { getLogger } from "./log.ts";
import { z as zod } from "zod";
import { globalConfig, trustedCidrs } from "../config/mod.ts";

const logger = getLogger(import.meta);

/**
 * Returns a V4 signer for S3 requests after loading configs.
 * @returns The V4 signer object.
 */
function getV4Signer(
  config: S3Config | SwiftConfig,
  /**
   * If other credentials are desired.
   */
  creds?: S3Config["credentials"],
) {
  const signer = new s.SignatureV4({
    region: config.region,
    credentials: creds ??
      ("accessKeyId" in config.credentials ? config.credentials : {
        // FIXME: swift username and password are not s3 creds, wouldn't work here unless we use them in the client sending the request
        accessKeyId: config.credentials.username,
        secretAccessKey: config.credentials.password,
      }),
    service: "s3", // TODO: get from config
    sha256: Sha256,
    applyChecksum: true,
  });

  return signer;
}

const preSignedQueryParamsSchema = zod.object({
  "x-amz-algorithm": zod.string(),
  "x-amz-credential": zod.string(),
  "x-amz-signature": zod.string(),
  "x-amz-signedheaders": zod.string(),
  "x-amz-expires": zod.string().transform((str, ctx) => {
    const parsed = parseInt(str);
    if (isNaN(parsed)) {
      ctx.addIssue({
        code: zod.ZodIssueCode.custom,
        message: "Not a number",
      });
      return zod.NEVER;
    }
    return parsed;
  }),
  "x-amz-date": zod.string().transform((str, ctx) => {
    try {
      return parseAmzDate(str);
    } catch {
      ctx.addIssue({
        code: zod.ZodIssueCode.custom,
        message: "Not a valid amz date",
      });
      return zod.NEVER;
    }
  }),
  "x-amz-content-sha256": zod.string().nullish(),
  "x-id": zod.string().nullish(),
});

/**
 * Extracts the signature from the request.
 *
 * @param {Request} request - The request object.
 * @throws {HeraldError} - If the authentication header is empty, the sign tag is missing, or the sign tag is invalid.
 */
export function extractSignature(request: Request) {
  const { searchParams } = new URL(request.url);
  const queryParams = Object.fromEntries(
    searchParams.entries().map(([key, val]) => [key.toLowerCase(), val]),
  );

  const parsed = preSignedQueryParamsSchema.safeParse(queryParams);

  // means it was a presigned request and the signature was in the query params
  if (parsed.success) {
    const sigV4Regex = /^([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request/;

    // check if the credential is valid
    const match = parsed.data["x-amz-credential"].match(sigV4Regex);
    if (!match) {
      const errResponse = getAPIErrorResponse(APIErrors.ErrInvalidSignTag);
      throw new HeraldError(
        errResponse.status,
        { res: errResponse },
      );
    }
    const [
      ,
      accessKeyId,
      dateStamp,
      region,
      service,
    ] = match;

    const signedHeaders = parsed.data["x-amz-signedheaders"].split(";").map((
      h,
    ) => h.trim().toLowerCase()).sort(); // Keep sorted

    return {
      source: "pre-sign" as const,
      expiresIn: parsed.data["x-amz-expires"],
      date: parsed.data["x-amz-date"],
      ...{
        algorithm: parsed.data["x-amz-algorithm"],
        accessKeyId,
        dateStamp,
        region,
        service,
        signedHeaders,
        signature: parsed.data["x-amz-signature"],
        credentialScope: `${dateStamp}/${region}/${service}/aws4_request`,
      } satisfies ReturnType<typeof parseAuthorizationHeader>,
    };
  }

  // means it was a signed request and the signature was in the header
  const authHeader = request.headers.get(AUTH_HEADER);
  if (authHeader === null) {
    const errResponse = getAPIErrorResponse(APIErrors.ErrAuthHeaderEmpty);
    throw new HeraldError(
      errResponse.status,
      { res: errResponse },
    );
  }
  const parsedHeader = parseAuthorizationHeader(authHeader);
  if (!parsedHeader) {
    const errResponse = getAPIErrorResponse(APIErrors.ErrMissingSignTag);
    throw new HeraldError(
      errResponse.status,
      { res: errResponse },
    );
  }

  const rawDate = request.headers.get(AMZ_DATE_HEADER) ??
    request.headers.get("Date");
  const date = rawDate ? parseAmzDate(rawDate) : undefined;
  return {
    source: "header" as const,
    date,
    ...parsedHeader,
  };
}

function parseAuthorizationHeader(
  authHeader: string,
) {
  const sigV4Regex =
    /^AWS4-([A-Z0-9-]+) Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=(.+)$/;
  const match = authHeader.match(sigV4Regex);

  if (!match) {
    return null;
  }

  const [
    ,
    algorithm,
    accessKeyId,
    dateStamp,
    region,
    service,
    signedHeadersStr,
    signature,
  ] = match;

  const signedHeaders = signedHeadersStr.split(";").map((h) =>
    h.trim().toLowerCase()
  ).sort(); // Keep sorted

  return {
    algorithm,
    accessKeyId,
    dateStamp,
    region,
    service,
    signedHeaders,
    signature,
    credentialScope: `${dateStamp}/${region}/${service}/aws4_request`,
  };
}

/**
 * Extracts the signed headers from the request.
 *
 * @param request - The request object.
 * @returns The signed headers as an array of strings.
 * @throws {HeraldError} If the authentication header is empty, the signed headers tag is missing, or the signed headers are invalid.
 */
function _extractSignedHeaders(request: Request) {
  const authHeader = request.headers.get(AUTH_HEADER);

  if (authHeader === null) {
    const errResponse = getAPIErrorResponse(APIErrors.ErrAuthHeaderEmpty);
    throw new HeraldError(
      errResponse.status,
      { res: errResponse },
    );
  }

  const splittedAuthHeader = authHeader.split(", ");
  let signedHeaders = splittedAuthHeader.at(1);

  if (signedHeaders === undefined) {
    const errResponse = getAPIErrorResponse(APIErrors.ErrMissingSignHeadersTag);
    throw new HeraldError(
      errResponse.status,
      { res: errResponse },
    );
  }

  const signedHeadersPrefix = "SignedHeaders=";
  if (
    signedHeaders.slice(0, signedHeadersPrefix.length) !== signedHeadersPrefix
  ) {
    const errResponse = getAPIErrorResponse(APIErrors.ErrInvalidSignHeaders);
    throw new HeraldError(
      errResponse.status,
      { res: errResponse },
    );
  }

  signedHeaders = signedHeaders.slice(signedHeadersPrefix.length);

  return signedHeaders.split(";");
}

/**
 * Signs the given request using AWS Signature Version 4.
 *
 * @param req - The request to be signed.
 * @returns A new signed request.
 */
export async function signRequestV4(
  req: Request,
  bucketConfig: S3Config | SwiftConfig,
) {
  const signer = getV4Signer(bucketConfig);

  const reqUrl = new URL(req.url);
  const crtHeaders: [string, string][] = [];
  const unsignedHeaders: string[] = [
    "accept",
    "accept-encoding",
    "accept-language",
    "content-length",
    "content-md5",
    "amz-sdk-invocation-id",
    "amz-sdk-request",
    "cdn-loop",
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "content-type",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
    "x-forwarded-scheme",
    "x-original-forwarded-for",
    "x-real-ip",
    "x-request-id",
    "x-scheme",
  ];
  const headersRecord: Record<string, string> = {};
  req.headers.forEach((val, key) => {
    headersRecord[key] = val;
    crtHeaders.push([key, val]);
  });

  const signableReq: HttpRequest = {
    method: req.method,
    headers: headersRecord,
    path: decodeURIComponent(reqUrl.pathname),
    hostname: reqUrl.hostname,
    protocol: reqUrl.protocol,
    port: parseInt(reqUrl.port),
    query: getQueryParameters(req),
    body: req.body,
  };

  const signed = await signer.sign(signableReq, {
    unsignableHeaders: new Set(unsignedHeaders),
  });

  const newReq = new Request(reqUrl, {
    method: signed.method,
    headers: signed.headers,
    body: signed.body,
    redirect: undefined,
  });

  return newReq;
}

/**
 * Verifies if an IP address is within the range of any of the given CIDR addresses.
 * @param ipAddress The IP address to check (e.g., "192.168.1.10").
 * @param cidrAddresses An array of CIDR address ranges (e.g., ["192.168.1.0/24", "10.0.0.0/8"]).
 * @returns True if the IP address is within any of the CIDR ranges, false otherwise.
 */
export function isIpInMultipleCidrRanges(
  ipAddress: string,
): boolean {
  const cidrs = trustedCidrs;
  for (const cidr of cidrs) {
    // Check if the IP address is contained within the current CIDR range
    if (cidr.contains(ipAddress)) {
      return true; // Match found in this CIDR range
    }
  }

  return false; // No match found in any of the CIDR ranges
}

// TODO: check if access key has access to object
/**
 * Verifies the V4 signature of the original request.
 *
 * @param originalRequest - The original request to verify.
 * @throws {HeraldError} - Throws an exception if the signature does not match.
 */
export async function verifyV4Signature(
  originalRequest: Request,
  bucketConfig: S3Config | SwiftConfig,
  bucketCredentials: Record<string, string>,
) {
  const originalSignature = extractSignature(originalRequest);

  const signer = getV4Signer(
    bucketConfig,
    bucketCredentials[originalSignature.accessKeyId]
      ? {
        accessKeyId: originalSignature.accessKeyId,
        secretAccessKey: bucketCredentials[originalSignature.accessKeyId],
      }
      : "accessKeyId" in bucketConfig.credentials
      ? bucketConfig.credentials
      : {
        accessKeyId: bucketConfig.credentials.username,
        secretAccessKey: bucketConfig.credentials.password,
      },
  );

  // https://aws.amazon.com/blogs/developer/clock-skew-correction/
  const CLOCK_SKEW = 15 * 60 * 1000;
  if (originalSignature.source == "pre-sign") {
    const now = new Date().getTime();
    const expiry = originalSignature.date.getTime() +
      originalSignature.expiresIn * 1000;
    if (now > expiry + CLOCK_SKEW) {
      const errResponse = getAPIErrorResponse(
        APIErrors.ErrExpiredPresign,
      );
      throw new HeraldError(errResponse.status, { res: errResponse });
    }
  }

  const signableRequest = toSignableRequest(
    originalRequest,
    originalSignature.signedHeaders,
  );
  const signedRequest = originalSignature.source == "pre-sign"
    ? await signer.presign(signableRequest, {
      signableHeaders: new Set(originalSignature.signedHeaders),
      expiresIn: originalSignature.expiresIn,
      signingDate: originalSignature.date,
      signingService: originalSignature.service,
    })
    : await signer.sign(signableRequest, {
      signableHeaders: new Set(originalSignature.signedHeaders),
      signingDate: originalSignature.date,
      signingService: originalSignature.service,
    });

  const signedNativeRequest = toNativeRequest(
    signedRequest,
    new URL(originalRequest.url),
  );

  const calculatedSignature = extractSignature(signedNativeRequest);

  if (originalSignature.signature !== calculatedSignature.signature) {
    logger.error("bad signature on request", {
      originalRequest,
    });
    const errResponse = getAPIErrorResponse(APIErrors.ErrSignatureDoesNotMatch);
    throw new HeraldError(errResponse.status, { res: errResponse });
  }
}

/**
 * Converts a Request object to a signable HttpRequest object.
 * @param req - The Request object to convert.
 * @returns A Promise that resolves to the converted HttpRequest object.
 */
export function toSignableRequest(
  req: Request,
  signedHeaders: string[],
): HttpRequest {
  const reqUrl = new URL(req.url);
  const headersRecord = {} as Record<string, string>;
  req.headers.forEach((val, key) => {
    const lower = key.toLowerCase();
    if (signedHeaders.some((sKey) => sKey == lower)) {
      headersRecord[key] = val;
    }
  });

  // get the forwarded host
  const forwardedHost = req.headers.get("x-forwarded-host");
  if (globalConfig.trust_proxy && forwardedHost) {
    const lastIp = req.headers.get("x-forwarded-for")?.split(",").pop()?.trim();
    if (
      !lastIp || !isIpInMultipleCidrRanges(lastIp)
    ) {
      logger.warn(
        "Request from untrusted IP",
        { lastIp, forwardedHost, headers: headersRecord },
      );
      throw new HeraldError(
        403,
        {
          res: getAPIErrorResponse(APIErrors.ErrAccessDenied),
        },
      );
    }

    headersRecord["host"] = forwardedHost;
  }

  const httpReq: HttpRequest = {
    method: req.method,
    headers: headersRecord,
    path: reqUrl.pathname,
    hostname: reqUrl.hostname,
    protocol: reqUrl.protocol,
    port: parseInt(reqUrl.port),
    query: getQueryParameters(req),
  };

  return httpReq;
}

/**
 * Converts an HttpRequest object to a native Request object.
 *
 * @param req - The HttpRequest object to convert.
 * @param reqUrl - The URL object representing the request URL.
 * @returns The converted Request object.
 */
export function toNativeRequest(
  req: HttpRequest,
  reqUrl: URL,
): Request {
  const reqBody = req.body;

  const newReq = new Request(reqUrl, {
    method: req.method,
    headers: req.headers,
    body: reqBody ? reqBody.value : undefined,
  });

  return newReq;
}

/**
 * Retrieves the query parameters from a given request.
 *
 * @param request - The request object.
 * @returns An object containing the query parameters.
 */
function getQueryParameters(request: Request): QueryParameterBag {
  const url = new URL(request.url);
  const params = new URLSearchParams(url.search);
  const queryParameters: QueryParameterBag = {};

  params.forEach((value, key) => {
    if (queryParameters[key]) {
      // If the key already exists and is not an array, convert it to an array
      if (!Array.isArray(queryParameters[key])) {
        queryParameters[key] = [queryParameters[key] as string];
      }
      // Add the new value to the array
      (queryParameters[key] as Array<string>).push(value);
    } else {
      // If the key doesn't exist, add it to the query parameters
      queryParameters[key] = value;
    }
  });

  return queryParameters;
}

function parseAmzDate(str: string) {
  let date = new Date(str);
  if (!isNaN(date.valueOf())) {
    return date;
  }
  date = new Date(
    str.replace(
      /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/,
      "$1-$2-$3T$4:$5:$6Z",
    ),
  );
  if (!isNaN(date.valueOf())) {
    return date;
  }
  throw new Error(`invalid amz date: ${str}`);
}
