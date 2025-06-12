import { S3Client } from "aws-sdk/client-s3";
import { envVarsConfig, getS3Config, proxyUrl } from "../config/mod.ts";
import { HonoRequest } from "@hono/hono";
import {
  methodSchema,
  RequestMeta,
  URLFormatStyle,
  urlFormatStyle,
} from "./types.ts";
import { HeraldError } from "../types/http-exception.ts";
import { isIP } from "../utils/url.ts";
import { getLogger } from "./log.ts";

const logger = getLogger(import.meta);
export function getS3Client(bucketName: string) {
  // deno-lint-ignore require-await no-explicit-any
  const loggingMiddleware = (next: any) => async (args: any) => {
    const { request } = args;
    // deno-lint-ignore no-console
    console.log("Request Details:", {
      url:
        `${request.protocol}//${request.hostname}:${request.port}${request.path}`,
      method: request.method,
      hostname: request.hostname,
      path: request.path,
      headers: request.headers,
    });
    return next(args);
  };

  const s3 = new S3Client({
    ...getS3Config(bucketName).config,
    endpoint: proxyUrl,
  });
  const envVar = envVarsConfig.log_level;
  const debug = envVar === "DEBUG";
  if (debug) {
    s3.middlewareStack.add(loggingMiddleware, {
      step: "finalizeRequest",
    });
  }

  return s3;
}

function extractMethod(request: HonoRequest | Request) {
  const parseResult = methodSchema.safeParse(request.method);

  if (!parseResult.success) {
    logger.critical(`Error Parsing Request Method: ${request.method}`);
    throw new Error(`Error Parsing Request Method: ${request.method}`);
  }

  const method = parseResult.data;
  return method;
}

function extractBucketName(request: Request): string | undefined {
  const urlFormat = getUrlFormat(request);
  const url = new URL(request.url);
  const path = url.pathname;
  const pathParts = path.split("/").filter((part) => part.length > 0);

  if (urlFormat === urlFormatStyle.Values.VirtualHosted) {
    const host = request.headers.get("host");
    const hostParts = host!.split(".");
    return hostParts[0];
  } else {
    // Path-style URL
    return pathParts[0] || undefined; // The first non-empty part of the path is the bucket name, or undefined if there isn't one
  }
}

function extractObjectKey(request: Request): string | undefined {
  const urlFormat = getUrlFormat(request);
  const url = new URL(request.url);
  const path = url.pathname;
  const pathParts = path.split("/").filter((part) => part.length > 0);

  if (urlFormat === urlFormatStyle.Values.VirtualHosted) {
    return pathParts.join("/"); // All path parts form the object key
  } else {
    // Path-style URL
    return pathParts.slice(1).join("/"); // All path parts after the bucket name form the object key
  }
}

/**
 * Retrieves the URL format style based on the provided HonoRequest object.
 *
 * @param request - The HonoRequest object containing the request information.
 * @returns The URL format style (VirtualHosted or Path).
 * @throws HTTPException if the request does not have a valid host.
 */
function getUrlFormat(request: Request): URLFormatStyle {
  const host = request.headers.get("host");
  if (!host) {
    throw new HeraldError(400, {
      message: `Invalid request: ${request.url}`,
    });
  }

  // Remove port if present
  const hostWithoutPort = host.split(":")[0];

  // If the host is an IP address or localhost, it's always path-style
  if (isIP(hostWithoutPort) || hostWithoutPort === "localhost") {
    return urlFormatStyle.Values.Path;
  }

  // For domain names, check if it's in the format "bucket-name.s3.amazonaws.com"
  const domainParts = hostWithoutPort.split(".");
  if (
    domainParts.length >= 3 &&
    (!domainParts[0].includes("s3") && !domainParts[0].includes("herald")) &&
    domainParts[domainParts.length - 3] !== "www"
  ) {
    return urlFormatStyle.Values.VirtualHosted;
  }

  // If we reach here, it's path-style
  return urlFormatStyle.Values.Path;
}

/**
 * Extracts the request information from the given HonoRequest object. Tje request
 *
 * @param request - The HonoRequest object containing the request information.
 * @returns {RequestMeta} The extracted request metadata.
 */
export function extractRequestInfo(request: Request): RequestMeta {
  const bucketName = extractBucketName(request) ?? null;
  const objectKey = extractObjectKey(request) ?? null;
  const urlFormat = getUrlFormat(request);
  const method = extractMethod(request);
  const url = new URL(request.url);
  const queryParams = url.searchParams;
  // Initialize a Record to store the parameters
  const queryRecord: Record<string, string[]> = {};

  // Iterate through all parameters
  queryParams.forEach((value, key) => {
    if (!queryRecord[key]) {
      queryRecord[key] = [];
    }
    queryRecord[key].push(value);
  });

  const reqMeta: RequestMeta = {
    bucket: bucketName,
    objectKey: objectKey || null,
    urlFormat,
    method,
    queryParams: queryRecord,
  };

  return reqMeta;
}
