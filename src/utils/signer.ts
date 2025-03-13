import { S3BucketConfig, S3Config } from "../config/mod.ts";
import { HttpRequest, QueryParameterBag } from "@smithy/types";
import { Sha256 } from "@aws-crypto/sha256";
import * as s from "@smithy/signature-v4";
import { AUTH_HEADER } from "../constants/headers.ts";
import { APIErrors, getAPIErrorResponse } from "../types/api_errors.ts";
import { HTTPException } from "../types/http-exception.ts";

/**
 * Returns a V4 signer for S3 requests after loading configs.
 * @returns The V4 signer object.
 */
function getV4Signer(config: S3Config) {
  const signer = new s.SignatureV4({
    region: config.region,
    credentials: config.credentials,
    service: "s3", // TODO: get from config
    sha256: Sha256,
    applyChecksum: true,
  });

  return signer;
}

/**
 * Extracts the signature from the request.
 *
 * @param {Request} request - The request object.
 * @returns {string} - The extracted signature.
 * @throws {HTTPException} - If the authentication header is empty, the sign tag is missing, or the sign tag is invalid.
 */
export function extractSignature(request: Request): string {
  const authHeader = request.headers.get(AUTH_HEADER);

  if (authHeader === null) {
    const errResponse = getAPIErrorResponse(APIErrors.ErrAuthHeaderEmpty);
    throw new HTTPException(
      errResponse.status,
      { res: errResponse },
    );
  }

  const splittedAuthHeader = authHeader.split(", ");
  const rawSignature = splittedAuthHeader.at(splittedAuthHeader.length - 1);

  if (!rawSignature) {
    const errResponse = getAPIErrorResponse(APIErrors.ErrMissingSignTag);
    throw new HTTPException(
      errResponse.status,
      { res: errResponse },
    );
  }

  const signaturePrefix = "Signature=";
  if (rawSignature?.slice(0, signaturePrefix.length - 1) !== signaturePrefix) {
    const errResponse = getAPIErrorResponse(APIErrors.ErrInvalidSignTag);
    throw new HTTPException(
      errResponse.status,
      { res: errResponse },
    );
  }

  return rawSignature.slice(signaturePrefix.length);
}

/**
 * Extracts the signed headers from the request.
 *
 * @param request - The request object.
 * @returns The signed headers as an array of strings.
 * @throws {HTTPException} If the authentication header is empty, the signed headers tag is missing, or the signed headers are invalid.
 */
function extractSignedHeaders(request: Request) {
  const authHeader = request.headers.get(AUTH_HEADER);

  if (authHeader === null) {
    const errResponse = getAPIErrorResponse(APIErrors.ErrAuthHeaderEmpty);
    throw new HTTPException(
      errResponse.status,
      { res: errResponse },
    );
  }

  const splittedAuthHeader = authHeader.split(", ");
  let signedHeaders = splittedAuthHeader.at(1);

  if (signedHeaders === undefined) {
    const errResponse = getAPIErrorResponse(APIErrors.ErrMissingSignHeadersTag);
    throw new HTTPException(
      errResponse.status,
      { res: errResponse },
    );
  }

  const signedHeadersPrefix = "SignedHeaders=";
  if (
    signedHeaders.slice(0, signedHeadersPrefix.length) !== signedHeadersPrefix
  ) {
    const errResponse = getAPIErrorResponse(APIErrors.ErrInvalidSignHeaders);
    throw new HTTPException(
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
  bucketConfig: S3Config,
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
  };

  const signed = await signer.sign(signableReq, {
    unsignableHeaders: new Set(unsignedHeaders),
  });

  const newReq = new Request(reqUrl, {
    method: signed.method,
    headers: signed.headers,
    body: req.body,
    redirect: undefined,
  });

  return newReq;
}

/**
 * Verifies the V4 signature of the original request.
 *
 * @param originalRequest - The original request to verify.
 * @throws {HTTPException} - Throws an exception if the signature does not match.
 */
export async function verifyV4Signature(
  originalRequest: Request,
  bucketConfig: S3BucketConfig,
) {
  const originalSignature = extractSignature(originalRequest);
  const signableHeaders = extractSignedHeaders(originalRequest);

  originalRequest.headers.delete(AUTH_HEADER);
  const signer = getV4Signer(bucketConfig.config);

  const signableRequest = await toSignableRequest(originalRequest);

  const signedRequest = await signer.sign(signableRequest, {
    signableHeaders: new Set(signableHeaders),
  });

  const signedNativeRequest = toNativeRequest(
    signedRequest,
    new URL(originalRequest.url),
  );

  const calculatedSignature = extractSignature(signedNativeRequest);

  if (originalSignature !== calculatedSignature) {
    const errResponse = getAPIErrorResponse(APIErrors.ErrSignatureDoesNotMatch);
    throw new HTTPException(errResponse.status, { res: errResponse });
  }
}

/**
 * Converts a Request object to a signable HttpRequest object.
 * @param req - The Request object to convert.
 * @returns A Promise that resolves to the converted HttpRequest object.
 */
export async function toSignableRequest(req: Request): Promise<HttpRequest> {
  const reqUrl = new URL(req.url);
  const crtHeaders: [string, string][] = [];
  const headersRecord: Record<string, string> = {};
  req.headers.forEach((val, key) => {
    headersRecord[key] = val;
    crtHeaders.push([key, val]);
  });

  const reqBody = await req.body?.getReader().read();

  const httpReq: HttpRequest = {
    method: req.method,
    headers: headersRecord,
    path: reqUrl.pathname,
    hostname: reqUrl.hostname,
    protocol: reqUrl.protocol,
    port: parseInt(reqUrl.port),
    body: reqBody ? reqBody.value : undefined,
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
