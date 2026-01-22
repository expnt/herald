import {
  HttpMiddleware,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { Effect } from "effect";
import { HeraldConfig } from "../Config/Layer.ts";
import { resolveCorsConfig } from "../Domain/Config.ts";

/**
 * Extracts the bucket name from the request URL path.
 * Assumes path format like /:bucket or /:bucket/*
 */
function extractBucketFromPath(url: string): string | undefined {
  try {
    const path = new URL(url, "http://localhost").pathname;
    const parts = path.split("/").filter((p) => p.length > 0);
    return parts.length > 0 ? parts[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Adds CORS headers to a response based on the provided config.
 */
function addCorsHeaders(
  response: HttpServerResponse.HttpServerResponse,
  cors: NonNullable<ReturnType<typeof resolveCorsConfig>>,
  request: HttpServerRequest.HttpServerRequest,
): HttpServerResponse.HttpServerResponse {
  const origin = request.headers["origin"];
  const headers = { ...response.headers };

  if (cors.allowedOrigins) {
    if (cors.allowedOrigins.includes("*")) {
      headers["access-control-allow-origin"] = "*";
    } else if (origin && cors.allowedOrigins.includes(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers["vary"] = headers["vary"]
        ? `${headers["vary"]}, Origin`
        : "Origin";
    }
  }

  if (cors.credentials) {
    headers["access-control-allow-credentials"] = "true";
  }

  if (cors.exposedHeaders) {
    headers["access-control-expose-headers"] = cors.exposedHeaders.join(", ");
  }

  return HttpServerResponse.setHeaders(response, headers);
}

/**
 * Creates a 204 No Content response for OPTIONS preflight requests.
 */
function makePreflightResponse(
  cors: NonNullable<ReturnType<typeof resolveCorsConfig>>,
  request: HttpServerRequest.HttpServerRequest,
): HttpServerResponse.HttpServerResponse {
  const origin = request.headers["origin"];
  const headers: Record<string, string> = {
    "access-control-max-age": String(cors.maxAge ?? 3600),
  };

  if (cors.allowedOrigins) {
    if (cors.allowedOrigins.includes("*")) {
      headers["access-control-allow-origin"] = "*";
    } else if (origin && cors.allowedOrigins.includes(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers["vary"] = "Origin";
    }
  }

  if (cors.credentials) {
    headers["access-control-allow-credentials"] = "true";
  }

  if (cors.allowedMethods) {
    headers["access-control-allow-methods"] = cors.allowedMethods.join(", ");
  } else {
    // Default to common S3 methods if not specified
    headers["access-control-allow-methods"] =
      "GET, PUT, POST, DELETE, HEAD, OPTIONS";
  }

  if (cors.allowedHeaders) {
    headers["access-control-allow-headers"] = cors.allowedHeaders.join(", ");
  } else {
    const requestedHeaders = request.headers["access-control-request-headers"];
    if (requestedHeaders) {
      headers["access-control-allow-headers"] = requestedHeaders;
    }
  }

  return HttpServerResponse.empty({ status: 204, headers });
}

/**
 * Custom CORS middleware that resolves configuration per-request based on the bucket.
 */
export const corsMiddleware = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* HeraldConfig;

    const bucket = extractBucketFromPath(request.url);
    const corsConfig = bucket
      ? resolveCorsConfig(config.raw, bucket)
      : config.raw.cors;

    if (!corsConfig) {
      return yield* app;
    }

    if (request.method === "OPTIONS") {
      return makePreflightResponse(corsConfig, request);
    }

    const response = yield* app;
    return addCorsHeaders(response, corsConfig, request);
  })
);
