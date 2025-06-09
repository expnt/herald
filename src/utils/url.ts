import { globalConfig, S3Config } from "../config/mod.ts";
import { getLogger, reportToSentry } from "./log.ts";
import { signRequestV4 } from "./signer.ts";
import { AUTH_HEADER, HOST_HEADER } from "../constants/headers.ts";
import { s3ReqParams } from "../constants/query-params.ts";
import { ReplicaConfig } from "../config/types.ts";
import { TIMEOUT } from "../constants/time.ts";

const logger = getLogger(import.meta);

/**
 * Returns the redirect URL for the given original URL and target URL.
 * @param originalUrl
 * @param targetUrl
 * @returns The redirect URL.
 */
export function getRedirectUrl(originalUrl: string, targetUrl: string): URL {
  const destUrl = new URL(targetUrl);

  const redirect = new URL(originalUrl);
  redirect.hostname = destUrl.hostname;
  redirect.protocol = destUrl.protocol;
  redirect.port = destUrl.port;
  redirect.host = destUrl.host;

  return redirect;
}

export function getReplicas(bucketName: string) {
  const replicas: ReplicaConfig[] = [];
  for (const replica of globalConfig.replicas) {
    const replicaBucket = replica.typ === "ReplicaS3Config"
      ? replica.config.bucket
      : replica.config.container;
    if (replicaBucket === bucketName) {
      replicas.push(replica);
    }
  }

  return replicas;
}

/**
 * Checks if the content length of the request is non-zero.
 *
 * @param request - The request to check.
 * @returns True if the content length is non-zero, false otherwise.
 */
export function isContentLengthNonZero(request: Request): boolean {
  const contentLength = request.headers.get("content-length");
  return contentLength !== null && parseInt(contentLength, 10) > 0;
}

/**
 * Forwards a request with timeouts. Before the request is forwarded, the incoming request will be verified using Signature V4 and the request will be signed to match the Signature expected by the object storage server.
 *
 * @param request - The request to be forwarded.
 * @returns A promise that resolves to the response of the forwarded request.
 */
export async function forwardS3RequestToS3WithTimeouts(
  request: Request,
  config: S3Config,
  retries = 3,
) {
  const forwardRequest = async () => {
    const redirect = getRedirectUrl(request.url, config.endpoint);

    let body: ReadableStream<Uint8Array> | undefined = undefined;

    // Check if the body exists and read it
    if (request.body && isContentLengthNonZero(request)) {
      body = request.body; // Deno body is already a ReadableStream
    }

    const headers = new Headers();
    for (const [key, value] of request.headers) {
      headers.append(key, value);
    }
    headers.set(HOST_HEADER, redirect.host);
    headers.delete(AUTH_HEADER);
    const toBeRemovedHeaders = [
      "baggage",
      "cdn-loop",
      "cf-connecting-ip",
      "cf-ipcountry",
      "cf-ray",
      "cf-visitor",
      "sentry-trace",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-port",
      "x-forwarded-proto",
      "x-forwarded-scheme",
      "x-original-forwarded-for",
      "x-real-ip",
      "x-request-id",
      "x-scheme",
      // "content-length",
      "content-md5",
    ];
    for (const key of toBeRemovedHeaders) {
      headers.delete(key);
    }

    const toBeRemovedQueryParams = [
      "X-Amz-Algorithm",
      "X-Amz-Credential",
      "X-Amz-Date",
      "X-Amz-Expires",
      "X-Amz-SignedHeaders",
      "X-Amz-Signature",
      "X-Amz-Content-Sha256",
      "x-id",
    ];

    toBeRemovedQueryParams.forEach((param) => {
      redirect.searchParams.delete(param);
    });

    const forwardReq = new Request(redirect, {
      method: request.method,
      headers,
      body: body,
    });

    const signed = await signRequestV4(forwardReq, config);

    const newRequest = new Request(redirect, {
      method: signed.method,
      headers: signed.headers,
      body: signed.body ?? undefined,
    });

    logger.debug(`Original URL: ${request.url}`);
    logger.debug(`Modified URL: ${redirect.toString()}`);

    // Need to add the url, or content-length gets set to -1
    const response = await fetch(redirect, newRequest);
    const clonedResponse = new Response(response.body, response);
    return clonedResponse;
  };

  const result = await retryWithExponentialBackoff(
    forwardRequest,
    retries,
    100,
    10000,
  );

  return result;
}

export function getBodyFromReq(
  req: Request,
): ReadableStream<Uint8Array> | undefined {
  if (req.body) {
    return req.body;
  }
}

// Utility function to delay execution
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Function to handle exponential backoff retries
export async function retryWithExponentialBackoff<T>(
  fn: () => Promise<T>,
  retries = 3,
  initialDelay = 100,
  maxDelay = 1000,
): Promise<T | Error> {
  let attempt = 0;
  let delayDuration = initialDelay;
  let err: Error = new Error("Unknown error");

  while (attempt < retries) {
    try {
      return await Promise.race([
        fn(),
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error("Operation timed out")), TIMEOUT)
        ),
      ]);
    } catch (error) {
      if (attempt >= retries - 1) {
        logger.critical(error);
        reportToSentry(error as Error);
        err = error as Error;
        attempt++;
      }

      await delay(delayDuration);
      delayDuration = Math.min(delayDuration * 2, maxDelay);
      attempt++;
    }
  }

  return err;
}

export function areQueryParamsSupported(queryParams: Set<string>): boolean {
  for (const param of queryParams) {
    if (!s3ReqParams.has(param)) {
      return false;
    }
  }

  return true;
}

export function formatParams(queryParams: Set<string>): string {
  return queryParams.values().toArray().join(", ");
}

/**
 * Checks if the given string is a valid IP address (IPv4 or IPv6).
 *
 * @param ip - The string to check.
 * @returns True if the string is a valid IP address, false otherwise.
 */
export function isIP(ip: string): boolean {
  // IPv4 regex pattern
  const ipv4Pattern =
    /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

  // IPv6 regex pattern
  const ipv6Pattern =
    /^(?:(?:[a-fA-F\d]{1,4}:){7}(?:[a-fA-F\d]{1,4}|:)|(?:[a-fA-F\d]{1,4}:){6}(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|:[a-fA-F\d]{1,4}|:)|(?:[a-fA-F\d]{1,4}:){5}(?::(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,2}|:)|(?:[a-fA-F\d]{1,4}:){4}(?:(?::[a-fA-F\d]{1,4}){0,1}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,3}|:)|(?:[a-fA-F\d]{1,4}:){3}(?:(?::[a-fA-F\d]{1,4}){0,2}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,4}|:)|(?:[a-fA-F\d]{1,4}:){2}(?:(?::[a-fA-F\d]{1,4}){0,3}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,5}|:)|(?:[a-fA-F\d]{1,4}:){1}(?:(?::[a-fA-F\d]{1,4}){0,4}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,6}|:)|(?::(?:(?::[a-fA-F\d]{1,4}){0,5}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,7}|:)))(?:%[0-9a-zA-Z]{1,})?$/;

  return ipv4Pattern.test(ip) || ipv6Pattern.test(ip);
}

export function serializeRequest(req: Request): Record<string, unknown> {
  return {
    url: req.url,
    method: req.method,
    headers: Object.fromEntries(req.headers.entries()),
    // body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : null,
  };
}

// deno-lint-ignore no-explicit-any
export function deserializeToRequest(data: Record<string, any>): Request {
  return new Request(data.url, {
    method: data.method,
    headers: new Headers(data.headers),
    // body: data.method !== 'GET' && data.method !== 'HEAD' ? data.body : null,
  });
}

export async function retryFetchWithTimeout<T>(
  fn: () => Promise<T>,
  retries = 5,
  initialDelay = 100,
  maxDelay = 1000,
  timeout = 10000,
): Promise<T | Error> {
  let attempt = 0;
  let delayDuration = initialDelay;
  let err: Error = new Error("Unknown error");

  while (attempt < retries) {
    try {
      const result = await Promise.race<[Promise<T>, Promise<Error>]>([
        fn(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), timeout)
        ),
      ]);
      return result;
    } catch (error) {
      if (attempt >= retries - 1) {
        logger.critical(error);
        reportToSentry(error as Error);
        err = error as Error;
        attempt++;
      }

      await delay(delayDuration);
      delayDuration = Math.min(delayDuration * 2, maxDelay);
      attempt++;
    }
  }

  return err;
}
