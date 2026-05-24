import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import {
  Backend,
  InternalError,
  InvalidRequest,
} from "../../Services/Backend.ts";
import { BackendResolver } from "../../Services/BackendResolver.ts";
import {
  decodeAwsChunkedBodyStream,
  hasAwsChunkedContentEncoding,
} from "../../Services/AwsChunked.ts";
import {
  ensureClientReadableKey,
  ensureClientWritableKey,
} from "../../Services/InternalNamespace.ts";
import { S3Xml } from "../../Services/S3Xml.ts";
import { S3RequestParser } from "../Utils.ts";
import { S3HeaderService } from "../../Services/S3HeaderService.ts";
import { RequestContext } from "../Utils.ts";
import { uploadPart } from "../Multipart/Put.ts";

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  const entry = Object.entries(headers).find(
    ([k]) => k.toLowerCase() === lower,
  );
  if (!entry) return undefined;
  const v = entry[1];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Parse x-amz-copy-source header. Format: /bucket/key or bucket/key, optional ?versionId=xxx.
 * Returns sourceBucket and sourceKey; fails with InvalidRequest if missing or malformed.
 */
function parseCopySource(
  value: string,
): Effect.Effect<
  { sourceBucket: string; sourceKey: string; versionId?: string },
  InvalidRequest
> {
  return Effect.gen(function* () {
    const trimmed = value.trim();
    if (!trimmed) {
      return yield* Effect.fail(
        new InvalidRequest({
          message: "x-amz-copy-source must be non-empty",
        }),
      );
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(trimmed);
    } catch {
      return yield* Effect.fail(
        new InvalidRequest({
          message: "x-amz-copy-source is not valid URL-encoded",
        }),
      );
    }
    const withoutQuery = decoded.includes("?")
      ? decoded.split("?")[0]
      : decoded;
    const path = withoutQuery.startsWith("/")
      ? withoutQuery.slice(1)
      : withoutQuery;
    const firstSlash = path.indexOf("/");
    if (firstSlash === -1) {
      return yield* Effect.fail(
        new InvalidRequest({
          message: "x-amz-copy-source must be /bucket/key or bucket/key",
        }),
      );
    }
    const sourceBucket = path.slice(0, firstSlash);
    const sourceKey = path.slice(firstSlash + 1);
    if (!sourceBucket) {
      return yield* Effect.fail(
        new InvalidRequest({
          message: "x-amz-copy-source source bucket is empty",
        }),
      );
    }
    if (!sourceKey) {
      return yield* Effect.fail(
        new InvalidRequest({
          message: "x-amz-copy-source source key is empty",
        }),
      );
    }
    let versionId: string | undefined;
    if (decoded.includes("?versionId=")) {
      const versionPart = decoded.split("?versionId=")[1];
      versionId = versionPart?.split("&")[0];
    }
    return { sourceBucket, sourceKey, versionId };
  });
}

/**
 * CopyObject: GET source object from source backend, PUT stream to destination.
 * Uses x-amz-metadata-directive: COPY (default) = use source metadata; REPLACE = use request headers.
 */
const copyObject = Effect.gen(function* () {
  const backend = yield* Backend;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { bucket } = yield* RequestContext;
  const { key } = yield* S3RequestParser;
  const headerService = yield* S3HeaderService;
  const resolver = yield* BackendResolver;
  const s3Xml = yield* S3Xml;

  const copySourceRaw = getHeader(request.headers, "x-amz-copy-source");
  if (!copySourceRaw) {
    return yield* Effect.fail(
      new InvalidRequest({
        message: "CopyObject requires x-amz-copy-source header",
      }),
    );
  }

  const { sourceBucket, sourceKey, versionId } = yield* parseCopySource(
    copySourceRaw,
  );
  yield* ensureClientReadableKey(sourceBucket, sourceKey);
  yield* ensureClientWritableKey(key);

  if (sourceBucket === bucket && sourceKey === key) {
    return yield* Effect.fail(
      new InvalidRequest({
        message: "CopyObject to the same key is not allowed",
      }),
    );
  }

  const metadataDirective = (getHeader(
    request.headers,
    "x-amz-metadata-directive",
  )?.toUpperCase() || "COPY") as "COPY" | "REPLACE";

  const sourceBackend = yield* resolver.getLayerForBucket(sourceBucket);

  // If source and dest backends are the same instance, use native copy.
  if (sourceBackend === backend) {
    const result = yield* backend.copyObject(
      sourceKey,
      key,
      metadataDirective,
      request.headers,
      sourceBucket,
    );
    const lastModified = result.lastModified !== undefined
      ? result.lastModified
      : new Date();
    return s3Xml.formatCopyObjectResult({
      etag: result.etag || "",
      lastModified,
    });
  }

  // Cross-backend copy: GET then PUT
  const getHeaders: Record<string, string | string[] | undefined> = {
    ...request.headers,
  };
  if (versionId) {
    getHeaders["x-amz-version-id"] = versionId;
  }

  const sourceResponse = yield* sourceBackend.getObject(
    sourceKey,
    getHeaders,
  );

  const isReplace = metadataDirective === "REPLACE";

  const putHeaders: Record<string, string | string[] | undefined> = {};
  if (sourceResponse.contentLength !== undefined) {
    putHeaders["content-length"] = String(sourceResponse.contentLength);
  }
  if (isReplace) {
    const ct = getHeader(request.headers, "content-type");
    if (ct) putHeaders["content-type"] = ct;
    const parsed = headerService.fromRequestHeaders(request.headers);
    for (const [k, v] of Object.entries(parsed.metadata)) {
      putHeaders[`x-amz-meta-${k}`] = v;
    }
  } else {
    const sourceContentType = sourceResponse.contentType ??
      (() => {
        const lower = "content-type";
        const entry = Object.entries(sourceResponse.headers).find(
          ([k]) => k.toLowerCase() === lower,
        );
        return entry ? entry[1] : undefined;
      })();
    if (sourceContentType) {
      putHeaders["content-type"] = sourceContentType;
    }
    for (const [k, v] of Object.entries(sourceResponse.metadata)) {
      if (!k.toLowerCase().startsWith("s3-checksum-")) {
        putHeaders[`x-amz-meta-${k}`] = v;
      }
    }
  }

  const putResult = yield* backend.putObject(
    key,
    sourceResponse.stream,
    putHeaders,
  );

  const etag = putResult.etag;
  if (!etag) {
    return yield* Effect.fail(
      new InternalError({ message: "CopyObject: no ETag from put" }),
    );
  }
  return s3Xml.formatCopyObjectResult({
    etag,
    lastModified: new Date(),
  });
});

/**
 * Handler for PutObject (PUT /:bucket/*)
 * If x-amz-copy-source is present, performs CopyObject (server-side copy) instead.
 */
export const putObject = Effect.gen(function* () {
  const backend = yield* Backend;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { sigV4Context } = yield* RequestContext;
  const { key, s3Params } = yield* S3RequestParser;
  yield* ensureClientWritableKey(key);
  const headerService = yield* S3HeaderService;

  if (s3Params.partNumber && s3Params.uploadId) {
    return yield* uploadPart;
  }

  const copySource = getHeader(request.headers, "x-amz-copy-source");
  if (copySource) {
    return yield* copyObject;
  }

  const hasAwsChunked = hasAwsChunkedContentEncoding(request.headers);
  yield* Effect.logDebug("PutObject aws-chunked decision", {
    key,
    hasAwsChunked,
    contentEncoding: getHeader(request.headers, "content-encoding"),
    transferEncoding: getHeader(request.headers, "transfer-encoding"),
    amzContentSha256: getHeader(request.headers, "x-amz-content-sha256"),
    amzDecodedContentLength: getHeader(
      request.headers,
      "x-amz-decoded-content-length",
    ),
    contentLength: getHeader(request.headers, "content-length"),
    contentType: getHeader(request.headers, "content-type"),
  });

  const bodyStream = hasAwsChunked
    ? decodeAwsChunkedBodyStream(request.stream, {
      headers: hasAwsChunked && sigV4Context === undefined
        ? {
          ...request.headers,
          // No auth context available: decode framing only and skip chunk-signature verification.
          "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
        }
        : request.headers,
      sigV4Context,
    })
    : request.stream;

  const result = yield* backend.putObject(
    key,
    bodyStream,
    request.headers,
  );

  const headers = headerService.toResponseHeaders(result);
  if (headers["Content-Length"] === undefined) {
    headers["Content-Length"] = "0";
  }
  return HttpServerResponse.empty({
    status: 200,
    headers,
  });
});
