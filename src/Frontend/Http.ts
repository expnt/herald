import {
  HttpApiBuilder,
  HttpMiddleware,
  HttpRouter,
  HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer, Option } from "effect";
import {
  type AccessControlPolicy,
  AccessDenied,
  type AclGrant,
  Backend,
  type BackendError,
  InvalidAccessKeyId,
  InvalidArgument,
  MethodNotAllowed,
  NoSuchBucket,
  NoSuchKey,
  RequestTimeTooSkewed,
} from "../Services/Backend.ts";
import {
  GROUP_URI_ALL_USERS,
  GROUP_URI_AUTHENTICATED_USERS,
} from "../Services/Acl.ts";
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
import {
  getBucketVersioning,
  putBucketVersioning,
} from "./Buckets/Versioning.ts";
import { getBucketAcl, putBucketAcl } from "./Buckets/Acl.ts";
import { getObjectAcl, putObjectAcl } from "./Objects/Acl.ts";
import { notImplementedSubresource } from "./Buckets/Subresources.ts";
import { HttpHeraldApi } from "../Api.ts";
import { BadGateway } from "./Api.ts";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import { HeraldConfig } from "../Config/Layer.ts";
import {
  verifyIncomingSigV2,
  verifyIncomingSigV4Detailed,
} from "../Services/Auth.ts";
import type {
  AuthCredentials,
  SigV4VerifiedContext,
} from "../Services/Auth.ts";

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
  return (
    typeof contentTypeValue === "string" &&
    contentTypeValue.toLowerCase().startsWith("multipart/form-data")
  );
}

function isLegacyAwsAuthorizationRequest(
  request: HttpServerRequest.HttpServerRequest,
): boolean {
  const authorization = request.headers["authorization"];
  return typeof authorization === "string" && authorization.startsWith("AWS ");
}

function getHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  if (!entry) {
    return undefined;
  }
  const value = entry[1];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Extracts the access key id from a legacy SigV2 Authorization header
 * ("AWS <accessKeyId>:<signature>"). The v2 verifier does not return a
 * SigV4VerifiedContext, so the principal is recovered from the header for
 * ACL-based authorization.
 */
function extractV2AccessKeyId(
  request: HttpServerRequest.HttpServerRequest,
): string | undefined {
  const authorization = request.headers["authorization"];
  if (typeof authorization !== "string") return undefined;
  const match = /^AWS\s+([^:]+):/.exec(authorization);
  return match?.[1];
}

type AclPermission =
  | "READ"
  | "WRITE"
  | "READ_ACP"
  | "WRITE_ACP"
  | "FULL_CONTROL";

type AclCheck =
  | {
    readonly kind: "acl";
    readonly permission: AclPermission;
    readonly target: "bucket" | "object";
  }
  | { readonly kind: "create-bucket" }
  | { readonly kind: "none" };

/**
 * Maps an S3 request to the ACL permission it requires. Bucket-level reads
 * (list/head) need bucket READ; object reads need the OBJECT's READ grant
 * (bucket READ does not grant object access in S3); object writes and
 * deletes need bucket WRITE; ACL subresources need READ_ACP/WRITE_ACP.
 * CreateBucket is special (any authenticated user may create buckets, and
 * anonymous creation is denied). Subresources that are NotImplemented by
 * design (tagging, policy, cors, ...) skip the ACL check.
 */
function aclCheckFor(
  method: string,
  subresource: string | undefined,
  isObjectRequest: boolean,
): AclCheck {
  if (isObjectRequest) {
    switch (subresource) {
      case "acl":
        return {
          kind: "acl",
          permission: method === "GET" ? "READ_ACP" : "WRITE_ACP",
          target: "object",
        };
      case "uploads":
      case "uploadId":
        return { kind: "acl", permission: "WRITE", target: "bucket" };
      case undefined:
        break;
      default:
        return { kind: "none" };
    }
    switch (method) {
      case "GET":
      case "HEAD":
        return { kind: "acl", permission: "READ", target: "object" };
      case "PUT":
      case "POST":
      case "DELETE":
        return { kind: "acl", permission: "WRITE", target: "bucket" };
      default:
        return { kind: "none" };
    }
  }
  switch (subresource) {
    case "acl":
      return {
        kind: "acl",
        permission: method === "GET" ? "READ_ACP" : "WRITE_ACP",
        target: "bucket",
      };
    case "versioning":
      return {
        kind: "acl",
        permission: method === "GET" ? "READ" : "WRITE",
        target: "bucket",
      };
    case "delete":
    case "uploads":
      return { kind: "acl", permission: "WRITE", target: "bucket" };
    case undefined:
      break;
    default:
      return { kind: "none" };
  }
  switch (method) {
    case "GET":
    case "HEAD":
      return { kind: "acl", permission: "READ", target: "bucket" };
    case "PUT":
      return { kind: "create-bucket" };
    case "DELETE":
      return { kind: "acl", permission: "FULL_CONTROL", target: "bucket" };
    case "POST":
      return { kind: "acl", permission: "WRITE", target: "bucket" };
    default:
      return { kind: "none" };
  }
}

/**
 * True when a grant authorizes the given principal for the required
 * permission. FULL_CONTROL implies every permission; group grants match
 * AllUsers (anonymous and authenticated) or AuthenticatedUsers
 * (authenticated only); CanonicalUser grants match by canonical id.
 */
function grantAllows(
  grant: AclGrant,
  principalId: string | undefined,
  required: AclPermission,
): boolean {
  if (grant.permission !== "FULL_CONTROL" && grant.permission !== required) {
    return false;
  }
  switch (grant.grantee.type) {
    case "CanonicalUser":
      return principalId !== undefined && grant.grantee.id === principalId;
    case "Group":
      if (grant.grantee.uri === GROUP_URI_ALL_USERS) return true;
      if (grant.grantee.uri === GROUP_URI_AUTHENTICATED_USERS) {
        return principalId !== undefined;
      }
      return false;
    case "AmazonCustomerByEmail":
      return false;
  }
}

/**
 * Query parameters that name S3 subresources. Authorization (and routing)
 * must not treat ordinary list query params (list-type, encoding-type,
 * prefix, …) as subresources — otherwise a request like GET /b?list-type=2
 * would skip the ACL gate entirely.
 */
const S3_SUBRESOURCE_PARAMS = new Set([
  "acl",
  "versioning",
  "tagging",
  "policy",
  "policyStatus",
  "cors",
  "lifecycle",
  "website",
  "logging",
  "replication",
  "notification",
  "inventory",
  "metrics",
  "intelligent-tiering",
  "ownershipControls",
  "publicAccessBlock",
  "object-lock",
  "delete",
  "uploads",
  "uploadId",
  "attributes",
  "restore",
  "legal-hold",
  "retention",
  "torrent",
]);

const firstS3Subresource = (url: URL): string | undefined =>
  Array.from(url.searchParams.keys()).find((k) =>
    S3_SUBRESOURCE_PARAMS.has(k)
  ) ?? undefined;

/**
 * The subset of the Backend service the ACL gate needs. Kept structural so
 * the gate does not depend on the full service shape.
 */
interface AclBackend {
  readonly getBucketAcl: (
    name: string,
  ) => Effect.Effect<AccessControlPolicy, BackendError>;
  readonly getObjectAcl: (
    key: string,
  ) => Effect.Effect<AccessControlPolicy, BackendError>;
}

/**
 * ACL-based authorization for anonymous and non-root principals. The root
 * user (the first configured auth credential) bypasses ACL checks entirely;
 * every other principal must hold the required grant on the bucket or
 * object ACL, or be the policy owner. Anonymous requests are authorized by
 * the AllUsers group grants only.
 */
function authorizeByAcl(
  request: HttpServerRequest.HttpServerRequest,
  bucket: string,
  key: string | undefined,
  principalId: string | undefined,
  backend: AclBackend,
): Effect.Effect<void, AccessDenied | BackendError> {
  const method = request.method ?? "UNKNOWN";
  const url = request.url.startsWith("http")
    ? new URL(request.url)
    : new URL(request.url, "http://localhost");
  const subresource = firstS3Subresource(url);
  const isObjectRequest = key !== undefined;

  const check = aclCheckFor(method, subresource, isObjectRequest);
  if (check.kind === "none") return Effect.void;
  if (check.kind === "create-bucket") {
    return principalId === undefined
      ? Effect.fail(new AccessDenied({ message: "Access Denied" }))
      : Effect.void;
  }

  return Effect.gen(function* () {
    const policy: AccessControlPolicy = yield* (
      check.target === "object" && key !== undefined
        ? backend.getObjectAcl(key)
        : backend.getBucketAcl(bucket)
    ).pipe(
      // A failed ACL lookup must not leak bucket/object existence to
      // callers who are not authorized anyway: report AccessDenied.
      Effect.catchIf(
        (e) => e instanceof NoSuchBucket || e instanceof NoSuchKey,
        () => Effect.fail(new AccessDenied({ message: "Access Denied" })),
      ),
    );

    if (principalId !== undefined && policy.owner.id === principalId) {
      return;
    }
    for (const grant of policy.grants) {
      if (grantAllows(grant, principalId, check.permission)) return;
    }
    return yield* Effect.fail(new AccessDenied({ message: "Access Denied" }));
  });
}

/** Build annotations and log 5xx as error, 4xx as warning; return response. */
function logRequestFailureAndReturn(
  err: unknown,
  response: HttpServerResponse.HttpServerResponse,
  bucket: string,
  method: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never> {
  const status = response.status ?? 500;
  const errorType = err != null &&
      typeof err === "object" &&
      "constructor" in err &&
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
    err != null &&
    typeof err === "object" &&
    "key" in err &&
    typeof (err as { key: unknown }).key === "string"
  ) {
    annotations.key = (err as { key: string }).key;
  }
  if (
    err != null &&
    typeof err === "object" &&
    "uploadId" in err &&
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

        const pathParts = pathWithoutPrefix.split("/").filter(Boolean);
        const bucket = pathParts[0] || "";
        const key = pathParts.slice(1).join("/") || undefined;
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
              getHeaderValue(request.headers, "authorization") !== undefined,
          });

          let authCredentials: Option.Option<AuthCredentials[]> = Option.none();
          let skipSigV4Auth = false;
          let v2AccessKeyId: string | undefined;

          if (bucket !== "") {
            authCredentials = config.resolveAuth(bucket);
            skipSigV4Auth = isPostObjectMultipartRequest(request);
            if (Option.isSome(authCredentials) && !skipSigV4Auth) {
              if (isLegacyAwsAuthorizationRequest(request)) {
                const v2Result = verifyIncomingSigV2(
                  request,
                  authCredentials.value,
                );
                if (!v2Result.valid) {
                  if (v2Result.failure === "MalformedAuthorization") {
                    return yield* Effect.fail(
                      new InvalidArgument({
                        message: "Authorization header is malformed",
                      }),
                    );
                  }
                  if (v2Result.failure === "RequestTimeTooSkewed") {
                    return yield* Effect.fail(
                      new RequestTimeTooSkewed({
                        message:
                          "The difference between the request time and the current time is too large.",
                      }),
                    );
                  }
                  return yield* Effect.fail(
                    new AccessDenied({ message: "Access Denied" }),
                  );
                }
                v2AccessKeyId = extractV2AccessKeyId(request);
              } else {
                if (hasSigV4Credentials(request)) {
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
                // No SigV4 credentials: anonymous request. Authorization is
                // decided by the bucket/object ACL below (public-read buckets
                // allow anonymous reads; everything else is denied).
              }
            }
          }

          const backend = yield* resolver.getLayerForBucket(bucket);
          const backendLayer = Layer.succeed(Backend, backend);

          // ACL-based authorization for anonymous and non-root principals.
          // The root user (the first configured auth credential) bypasses
          // ACL checks; every other principal must hold the required grant
          // on the bucket/object ACL or be the policy owner.
          if (Option.isSome(authCredentials) && !skipSigV4Auth) {
            const principalId = sigV4Context?.accessKeyId ?? v2AccessKeyId;
            const primaryId = authCredentials.value[0]?.accessKeyId;
            if (principalId === undefined || principalId !== primaryId) {
              yield* authorizeByAcl(
                request,
                bucket,
                key,
                principalId,
                backend,
              );
            }
          }

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

    const router = HttpRouter.empty.pipe(
      HttpRouter.get("/health", HttpServerResponse.json({ status: "ok" })),
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
          const method = request.method ?? "UNKNOWN";
          // Bucket subresource dispatch: S3 routes subresource operations by
          // query parameter (e.g. ?versioning, ?acl, ?tagging). Without this,
          // every subresource request fell through to createBucket/deleteBucket
          // and produced spurious BucketAlreadyOwnedByYou errors.
          const url = request.url.startsWith("http")
            ? new URL(request.url)
            : new URL(request.url, "http://localhost");
          const subresource = url.searchParams.keys().next().value;
          if (subresource !== undefined) {
            switch (subresource) {
              case "versioning":
                if (method === "GET") {
                  return yield* frontHandler(getBucketVersioning);
                }
                if (method === "PUT") {
                  return yield* frontHandler(putBucketVersioning);
                }
                break;
              case "acl":
                if (method === "PUT") {
                  return yield* frontHandler(putBucketAcl);
                }
                if (method === "GET") {
                  return yield* frontHandler(getBucketAcl);
                }
                break;
              case "tagging":
              case "policy":
              case "cors":
              case "lifecycle":
              case "website":
              case "logging":
              case "replication":
              case "notification":
              case "inventory":
              case "metrics":
              case "intelligent-tiering":
              case "ownershipControls":
              case "publicAccessBlock":
              case "object-lock":
                return yield* frontHandler(
                  notImplementedSubresource(subresource),
                );
              default:
                break;
            }
          }
          if (method === "GET") {
            return yield* frontHandler(listObjects);
          }
          if (method === "PUT") {
            return yield* frontHandler(createBucket);
          }
          if (method === "DELETE") {
            return yield* frontHandler(deleteBucket);
          }
          if (method === "HEAD") {
            return yield* frontHandler(headBucket);
          }
          if (method === "POST") {
            return yield* frontHandler(postObject);
          }
          return yield* Effect.fail(
            new MethodNotAllowed({
              message: `Method ${method} not implemented for bucket operations`,
            }),
          );
        }),
      ),
      HttpRouter.all(
        "/:bucket/*",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          // Object subresource dispatch: S3 routes object subresource
          // operations by query parameter (e.g. ?acl).
          const url = request.url.startsWith("http")
            ? new URL(request.url)
            : new URL(request.url, "http://localhost");
          const subresource = url.searchParams.keys().next().value;
          if (subresource === "acl") {
            if (request.method === "PUT") {
              return yield* frontHandler(putObjectAcl);
            }
            if (request.method === "GET") {
              return yield* frontHandler(getObjectAcl);
            }
          }
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
      ? HttpRouter.empty.pipe(
        HttpRouter.mount(
          prefix.startsWith("/")
            ? (prefix as `/${string}`)
            : (`/${prefix}` as `/${string}`),
          router,
        ),
      )
      : router;
  });

export const HttpS3Live = Layer.unwrapEffect(
  Effect.gen(function* () {
    const router = yield* makeS3Router();
    return HttpApiBuilder.group(HttpHeraldApi, "s3", (handlers) => {
      const handler = (req: {
        readonly request: HttpServerRequest.HttpServerRequest;
      }) =>
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
            const errorType = err != null &&
                typeof err === "object" &&
                "constructor" in err &&
                typeof (err as { constructor: { name?: string } }).constructor
                    ?.name === "string"
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
      return handlers
        .handleRaw("postRoot", handler)
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
