import { Effect } from "effect";
import { HttpServerResponse } from "@effect/platform";
import { RequestContext } from "../Utils.ts";

export const createBucket = () =>
  Effect.gen(function* () {
    const { backend, bucket, params, request } = yield* RequestContext;

    yield* Effect.logDebug(
      `createBucket bucket=[${bucket}] url=[${request.url}]`,
    );

    if (params.acl !== undefined) {
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
      yield* backend.headBucket();
      return HttpServerResponse.text("", { status: 200 });
    }

    yield* backend.createBucket();
    return HttpServerResponse.text("", { status: 200 });
  });
