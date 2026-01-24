import { Effect } from "effect";
import { HttpServerResponse } from "@effect/platform";
import { RequestContext } from "../Utils.ts";
import { S3HeaderService } from "../../Services/S3HeaderService.ts";

/**
 * Handler for PutObject (PUT /:bucket/*)
 */
export const putObject = () =>
  Effect.gen(function* () {
    const { backend, key, params, request } = yield* RequestContext;
    const headerService = yield* S3HeaderService;

    const headersWithLen = { ...request.headers };
    const len = request.headers["content-length"];
    if (len) {
      headersWithLen["content-length"] = len;
    }

    if (params.partNumber && params.uploadId) {
      // Upload Part
      const result = yield* backend.uploadPart(
        key,
        params.uploadId,
        params.partNumber,
        request.stream,
        headersWithLen,
      );

      return HttpServerResponse.empty({
        status: 200,
        headers: headerService.toResponseHeaders(result),
      });
    }

    const result = yield* backend.putObject(
      key,
      request.stream,
      headersWithLen,
    );

    return HttpServerResponse.empty({
      status: 200,
      headers: headerService.toResponseHeaders(result),
    });
  });
