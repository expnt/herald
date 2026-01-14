import { Effect } from "effect"
import { HttpServerResponse } from "@effect/platform"
import { resolveBucket } from "../Utils.ts"

export const headBucket = ({ path: { bucket } }: { path: { bucket: string } }) =>
  resolveBucket(bucket, (backend) =>
    Effect.gen(function* () {
      yield* backend.headBucket()
      return HttpServerResponse.empty({ status: 200 })
    })
  )
