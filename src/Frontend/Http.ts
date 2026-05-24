import {
  HttpApiBuilder,
  HttpMiddleware,
  HttpRouter,
  HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer, Option } from "effect";
import {
  AccessDenied,
  Backend,
  InvalidAccessKeyId,
  InvalidArgument,
  MethodNotAllowed,
  RequestTimeTooSkewed,
} from "../Services/Backend.ts";
import { BackendResolver } from "../Services/BackendResolver.ts";
import { S3Xml } from "../Services/S3Xml.ts";
import { RequestContext } from "./Utils.ts";
import { listObjects } from "./Objects/List.ts";
import { postObject } from "./Objects/Post.ts";
import { getObject } from "./Objects/Get.ts";
import { putObject } from "./Objects/Put.ts";
import { deleteObject } from "./Objects/Delete.ts";
import { headObject } from "./Objects/Head.ts";
import { createBucket } from "./Buckets/Create.ts";
import { deleteBucket } from "./Buckets/Delete.ts";
import { headBucket } from "./Buckets/Head.ts";
import { HttpHeraldApi } from "../Api.ts";
import { BadGateway } from "./Api.ts";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import { HeraldConfig } from "../Config/Layer.ts";
import { verifyIncomingSigV4Detailed } from "../Services/Auth.ts";
import type { SigV4VerifiedContext } from "../Services/Auth.ts";

/**
 * Middleware that at debug log level logs every outgoing response's status and
 * all headers. Centralized here so all S3/health responses get consistent
 * debug logging.
 */
export const responseDebugLoggingMiddleware = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const response = yield* app;
    const status = response.status ?? 0;
    const headers = response.headers ?? {};
    const headersStr = JSON.stringify(headers);
    const method = request.method ?? "UNKNOWN";
    const url = request.url.startsWith("http")
      ? new URL(request.url).pathname
      : request.url.split("?")[0];
    yield* Effect.logDebug("Outgoing response", {
      status,
      method,
      url,
      headers: headersStr,
    });
    return response;
  })
);

function hasSigV4Credentials(
  request: HttpServerRequest.HttpServerRequest,
): boolean {
  if (typeof request.headers["authorization"] === "string") {
    return true;
  }
  const hostHeader = request.headers["host"];
  const host = typeof hostHeader === "string" ? hostHeader : "localhost";
  const protocol = request.url.startsWith("https") ? "https:" : "http:";
  const url = new URL(request.url, `${protocol}//${host}`);
  return url.searchParams.has("X-Amz-Signature");
}

function isPostObjectMultipartRequest(
  request: HttpServerRequest.HttpServerRequest,
): boolean {
  if (request.method !== "POST") {
    return false;
  }
  const contentType = request.headers["content-type"] ??
    request.headers["Content-Type"];
  const contentTypeValue = Array.isArray(contentType)
    ? contentType[0]
    : contentType;
  return typeof contentTypeValue === "string" &&
    contentTypeValue.toLowerCase().startsWith("multipart/form-data");
}

function isLegacyAwsAuthorizationRequest(
  request: HttpServerRequest.HttpServerRequest,
): boolean {
  const authorization = request.headers["authorization"];
  return typeof authorization === "string" &&
    authorization.startsWith("AWS ");
}

function getHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const entry = Object.entries(headers).find(([key]) =>
    key.toLowerCase() === name.toLowerCase()
  );
  if (!entry) {
    return undefined;
  }
  const value = entry[1];
  return Array.isArray(value) ? value[0] : value;
}

/** Build annotations and log 5xx as error, 4xx as warning; return response. */
function logRequestFailureAndReturn(
  err: unknown,
  response: HttpServerResponse.HttpServerResponse,
  bucket: string,
  method: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never> {
  const status = response.status ?? 500;
  const errorType =
    err != null && typeof err === "object" && "constructor" in err &&
      typeof (err as { constructor: { name?: string } }).constructor?.name ===
        "string"
      ? (err as { constructor: { name: string } }).constructor.name
      : "Unknown";
  const message = err instanceof Error ? err.message : String(err);
  const annotations: Record<string, string | number> = {
    status,
    errorType,
    message,
    bucket,
    method,
  };
  if (
    err != null && typeof err === "object" && "key" in err &&
    typeof (err as { key: unknown }).key === "string"
  ) {
    annotations.key = (err as { key: string }).key;
  }
  if (
    err != null && typeof err === "object" && "uploadId" in err &&
    typeof (err as { uploadId: unknown }).uploadId === "string"
  ) {
    annotations.uploadId = (err as { uploadId: string }).uploadId;
  }
  return Effect.gen(function* () {
    if (status >= 500) {
      yield* Effect.logError("Request failed", annotations);
    } else if (status >= 400) {
      yield* Effect.logWarning("Request failed", annotations);
    }
    return response;
  });
}

/**
 * Main HTTP Router for the S3 Proxy.
 */
export const makeS3Router = (prefix = "") =>
  Effect.gen(function* () {
    const s3Xml = yield* S3Xml;
    const resolver = yield* BackendResolver;
    const config = yield* HeraldConfig;

    const frontHandler = <R, E>(
      handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
    ) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        // Extract bucket name from URL path
        // request.url might be a full URL or just a pathname
        const pathname = request.url.startsWith("http")
          ? new URL(request.url).pathname
          : request.url.split("?")[0]; // Remove query string if present

        // Remove prefix from pathname before extracting bucket
        let pathWithoutPrefix = pathname;
        if (prefix) {
          // Normalize prefix: ensure it starts with / and remove trailing /
          const normalizedPrefix = prefix.startsWith("/")
            ? prefix
            : `/${prefix}`;
          const cleanPrefix = normalizedPrefix.endsWith("/")
            ? normalizedPrefix.slice(0, -1)
            : normalizedPrefix;

          // Check if pathname starts with the prefix (exact match)
          if (pathname.startsWith(cleanPrefix)) {
            pathWithoutPrefix = pathname.substring(cleanPrefix.length);
            // Ensure it starts with / after prefix removal
            if (!pathWithoutPrefix.startsWith("/")) {
              pathWithoutPrefix = `/${pathWithoutPrefix}`;
            }
          }
        }

        const bucket = pathWithoutPrefix.split("/").filter(Boolean)[0] || "";
        const isHead = request.method === "HEAD";
        const method = request.method ?? "UNKNOWN";
        const query = request.url.includes("?")
          ? request.url.slice(request.url.indexOf("?") + 1)
          : "";

        const attrs = { bucket, method };
        return yield* Effect.gen(function* () {
          let sigV4Context: SigV4VerifiedContext | undefined;

          yield* Effect.logDebug("Incoming request", {
            method,
            path: pathname,
            query,
            bucket,
            contentEncoding: getHeaderValue(
              request.headers,
              "content-encoding",
            ),
            transferEncoding: getHeaderValue(
              request.headers,
              "transfer-encoding",
            ),
            amzContentSha256: getHeaderValue(
              request.headers,
              "x-amz-content-sha256",
            ),
            amzDecodedContentLength: getHeaderValue(
              request.headers,
              "x-amz-decoded-content-length",
            ),
            contentLength: getHeaderValue(request.headers, "content-length"),
            contentType: getHeaderValue(request.headers, "content-type"),
            hasAuthorization:
              getHeaderValue(request.headers, "authorization") !==
                undefined,
          });

          if (bucket !== "") {
            const authCredentials = config.resolveAuth(bucket);
            const skipSigV4Auth = isPostObjectMultipartRequest(request);
            if (Option.isSome(authCredentials) && !skipSigV4Auth) {
              if (isLegacyAwsAuthorizationRequest(request)) {
                return yield* Effect.fail(
                  new InvalidArgument({
                    message:
                      "The authorization mechanism you have provided is not supported. Please use AWS4-HMAC-SHA256.",
                  }),
                );
              }
              if (!hasSigV4Credentials(request)) {
                return yield* Effect.fail(
                  new AccessDenied({ message: "Access Denied" }),
                );
              }

              const resolvedBucket = config.lookupBucket(bucket);
              if (Option.isNone(resolvedBucket)) {
                return yield* Effect.fail(
                  new AccessDenied({ message: "Access Denied" }),
                );
              }
              const bucketRegion = resolvedBucket.value.region;
              if (
                bucketRegion === undefined || bucketRegion.trim() === ""
              ) {
                return yield* Effect.fail(
                  new AccessDenied({ message: "Access Denied" }),
                );
              }

              const validation = yield* verifyIncomingSigV4Detailed(
                request,
                authCredentials.value,
                bucketRegion,
              );
              if (!validation.valid) {
                if (
                  validation.failure === "MalformedAuthorization" ||
                  validation.failure === "InvalidExpires"
                ) {
                  return yield* Effect.fail(
                    new InvalidArgument({
                      message: "Authorization header is malformed",
                    }),
                  );
                }
                if (validation.failure === "RequestTimeTooSkewed") {
                  return yield* Effect.fail(
                    new RequestTimeTooSkewed({
                      message:
                        "The difference between the request time and the current time is too large.",
                    }),
                  );
                }
                if (
                  validation.failure === "ExpiredPresign" ||
                  validation.failure === "PresignNotYetValid" ||
                  validation.failure === "PresignExpiresTooLong"
                ) {
                  return yield* Effect.fail(
                    new AccessDenied({ message: "Request has expired" }),
                  );
                }
                if (validation.failure === "UnknownAccessKey") {
                  return yield* Effect.fail(
                    new InvalidAccessKeyId({
                      message:
                        "The AWS Access Key Id you provided does not exist in our records.",
                    }),
                  );
                }
                return yield* Effect.fail(
                  new AccessDenied({ message: "Access Denied" }),
                );
              }
              sigV4Context = validation.context;
            }
          }

          const backend = yield* resolver.getLayerForBucket(bucket);
          const backendLayer = Layer.succeed(Backend, backend);

          return yield* handler.pipe(
            Effect.provideService(RequestContext, { bucket, sigV4Context }),
            Effect.provide(backendLayer),
          );
        }).pipe(
          // convert the frontend errors to xml and log failure details
          Effect.catchAll((err: unknown) => {
            const response = s3Xml.formatError(err, isHead);
            return logRequestFailureAndReturn(err, response, bucket, method);
          }),
          Effect.annotateLogs(attrs),
          Effect.withSpan("herald.s3.request", { attributes: attrs }),
        );
      });

    const router = HttpRouter.empty
      .pipe(
        HttpRouter.get(
          "/health",
          HttpServerResponse.json({ status: "ok" }),
        ),
        // List Buckets (GET /)
        HttpRouter.get(
          "/",
          Effect.gen(function* () {
            const backendInstance = yield* resolver.getLayerForBucket("");
            const backendLayer = Layer.succeed(Backend, backendInstance);
            const result = yield* Effect.gen(function* () {
              const backend = yield* Backend;
              return yield* backend.listBuckets();
            }).pipe(Effect.provide(backendLayer));
            return s3Xml.formatListBuckets(result.buckets, result.owner);
          }).pipe(
            Effect.catchAll((err: unknown) => {
              const response = s3Xml.formatError(err);
              return logRequestFailureAndReturn(err, response, "", "GET");
            }),
          ),
        ),
        // Bucket/Object operations
        HttpRouter.all(
          "/:bucket",
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            if (request.method === "GET") {
              return yield* frontHandler(listObjects);
            }
            if (request.method === "PUT") {
              return yield* frontHandler(createBucket);
            }
            if (request.method === "DELETE") {
              return yield* frontHandler(deleteBucket);
            }
            if (request.method === "HEAD") {
              return yield* frontHandler(headBucket);
            }
            if (request.method === "POST") {
              return yield* frontHandler(postObject);
            }
            return yield* Effect.fail(
              new MethodNotAllowed({
                message:
                  `Method ${request.method} not implemented for bucket operations`,
              }),
            );
          }),
        ),
        HttpRouter.all(
          "/:bucket/*",
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            if (request.method === "GET") return yield* frontHandler(getObject);
            if (request.method === "PUT") return yield* frontHandler(putObject);
            if (request.method === "POST") {
              return yield* frontHandler(postObject);
            }
            if (request.method === "DELETE") {
              return yield* frontHandler(deleteObject);
            }
            if (request.method === "HEAD") {
              return yield* frontHandler(headObject);
            }
            return yield* Effect.fail(
              new MethodNotAllowed({
                message: `Method ${request.method} not implemented`,
              }),
            );
          }),
        ),
      );

    return prefix
      ? HttpRouter.empty.pipe(HttpRouter.mount(
        prefix.startsWith("/")
          ? prefix as `/${string}`
          : `/${prefix}` as `/${string}`,
        router,
      ))
      : router;
  });

export const HttpS3Live = Layer.unwrapEffect(
  Effect.gen(function* () {
    const router = yield* makeS3Router();
    return HttpApiBuilder.group(HttpHeraldApi, "s3", (handlers) => {
      const handler = (
        req: { readonly request: HttpServerRequest.HttpServerRequest },
      ) =>
        router.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            req.request,
          ),
          Effect.catchAll((err: unknown) => {
            const request = req.request;
            const method = request.method ?? "UNKNOWN";
            const url = request.url.startsWith("http")
              ? new URL(request.url).pathname
              : request.url.split("?")[0];
            const errorType =
              err != null && typeof err === "object" && "constructor" in err &&
                typeof (err as { constructor: { name?: string } })
                    .constructor?.name === "string"
                ? (err as { constructor: { name: string } }).constructor.name
                : "Unknown";
            const message = err instanceof Error ? err.message : String(err);
            return Effect.gen(function* () {
              yield* Effect.logError("Request failed", {
                status: 502,
                errorType,
                message,
                method,
                url,
              });
              return yield* Effect.fail(
                new BadGateway({ message: String(err) }),
              );
            });
          }),
        ) as Effect.Effect<
          HttpServerResponse.HttpServerResponse,
          BadGateway,
          never
        >;
      return handlers.handleRaw("postRoot", handler)
        .handleRaw("listBuckets", handler)
        .handleRaw("listObjects", handler)
        .handleRaw("createBucket", handler)
        .handleRaw("deleteBucket", handler)
        .handleRaw("headBucket", handler)
        .handleRaw("postBucket", handler)
        .handleRaw("getObject", handler)
        .handleRaw("putObject", handler)
        .handleRaw("postObject", handler)
        .handleRaw("deleteObject", handler)
        .handleRaw("headObject", handler);
    });
  }),
);
