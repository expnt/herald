import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { resolveBucket } from "../Utils.ts";

export const createBucket = (
  { path: { bucket } }: { path: { bucket: string } },
) =>
  resolveBucket(bucket, (backend) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, "http://localhost");
      yield* Effect.logDebug(
        `createBucket bucket=[${bucket}] url=[${request.url}]`,
      );

      if (url.searchParams.has("acl")) {
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
    }));
