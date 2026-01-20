import { Effect } from "effect";
import { HttpClient } from "@effect/platform";
import type { BackendError, BackendService } from "../../Services/Backend.ts";
import type { MaterializedBucket } from "../../Domain/Config.ts";
import { makeBucketOps } from "./Buckets.ts";
import { makeObjectOps } from "./Objects.ts";
import { getTarget } from "./Utils.ts";
import type { SwiftClient } from "./Client.ts";

/**
 * Creates a Swift-specific Backend implementation for a given configuration context.
 * Composes bucket and object operations modularly.
 * Resolves the target and client once per backend creation (request-scoped).
 */
export const makeSwiftBackend = (
  bucket: MaterializedBucket | { backend_id: string },
): Effect.Effect<
  BackendService,
  BackendError,
  SwiftClient | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const target = yield* getTarget(bucket);
    const client = yield* HttpClient.HttpClient;
    return {
      ...makeBucketOps(target, client),
      ...makeObjectOps(target, client),
    } satisfies BackendService;
  });
