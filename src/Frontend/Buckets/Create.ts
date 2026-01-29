import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { RequestContext, S3RequestParser } from "../Utils.ts";
import { Backend } from "../../Services/Backend.ts";

export const createBucket = Effect.gen(function* () {
  const backend = yield* Backend;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const parser = yield* S3RequestParser;
  const { bucket } = yield* RequestContext;

  // #region agent log
  fetch("http://127.0.0.1:7242/ingest/72b12113-1956-40fa-93e1-a5c755ed9c35", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: "Buckets/Create.ts:7",
      message: "createBucket entry",
      data: { bucket, url: request.url },
      timestamp: Date.now(),
      sessionId: "debug-session",
      runId: "run1",
      hypothesisId: "E",
    }),
  }).catch(() => {});
  // #endregion

  yield* Effect.logDebug(
    `createBucket bucket=[${bucket}] url=[${request.url}]`,
  );

  const { s3Params } = parser;

  if (s3Params.acl !== undefined) {
    // PutBucketAcl
    // Check for canned ACL validity if present
    const cannedAcl = request.headers["x-amz-acl"];
    const validCannedAcls = [
      "private",
      "public-read",
      "public-read-write",
      "authenticated-read",
    ];
    if (cannedAcl && !validCannedAcls.includes(cannedAcl)) {
      return HttpServerResponse.text(
        `<?xml version="1.0" encoding="UTF-8"?><Error><Code>InvalidArgument</Code><Message>Argument x-amz-acl is invalid.</Message></Error>`,
        { status: 400, headers: { "Content-Type": "application/xml" } },
      );
    }

    // For now, we just return 200 OK if the bucket exists
    yield* backend.headBucket(bucket);
    return HttpServerResponse.text("", { status: 200 });
  }

  // #region agent log
  fetch("http://127.0.0.1:7242/ingest/72b12113-1956-40fa-93e1-a5c755ed9c35", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: "Buckets/Create.ts:40",
      message: "Calling backend.createBucket",
      data: { bucket },
      timestamp: Date.now(),
      sessionId: "debug-session",
      runId: "run1",
      hypothesisId: "E",
    }),
  }).catch(() => {});
  // #endregion
  yield* backend.createBucket(bucket, request.headers).pipe(
    Effect.tapError((err) => {
      // #region agent log
      fetch(
        "http://127.0.0.1:7242/ingest/72b12113-1956-40fa-93e1-a5c755ed9c35",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "Buckets/Create.ts:44",
            message: "backend.createBucket error",
            data: {
              bucket,
              errorType: err?.constructor?.name,
              errorMessage: err instanceof Error ? err.message : String(err),
            },
            timestamp: Date.now(),
            sessionId: "debug-session",
            runId: "run1",
            hypothesisId: "D",
          }),
        },
      ).catch(() => {});
      // #endregion
      return Effect.void;
    }),
  );
  // #region agent log
  fetch("http://127.0.0.1:7242/ingest/72b12113-1956-40fa-93e1-a5c755ed9c35", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: "Buckets/Create.ts:50",
      message: "backend.createBucket success",
      data: { bucket },
      timestamp: Date.now(),
      sessionId: "debug-session",
      runId: "run1",
      hypothesisId: "E",
    }),
  }).catch(() => {});
  // #endregion
  return HttpServerResponse.text("", { status: 200 });
});
