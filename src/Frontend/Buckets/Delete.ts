import { Effect } from "effect";
import { HttpServerResponse } from "@effect/platform";
import { resolveBucket } from "../Utils.ts";

export const deleteBucket = (
  { path: { bucket } }: { path: { bucket: string } },
) =>
  resolveBucket(bucket, (backend) =>
    Effect.gen(function* () {
      yield* backend.deleteBucket();
      return HttpServerResponse.empty({ status: 204 });
    }));
