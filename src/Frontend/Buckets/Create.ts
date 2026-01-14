import { Effect } from "effect"
import { HttpServerResponse } from "@effect/platform"
import { resolveBucket } from "../Utils.ts"

export const createBucket = ({ path: { bucket } }: { path: { bucket: string } }) =>
  resolveBucket(bucket, (backend) =>
    Effect.gen(function* () {
      yield* backend.createBucket()
      return HttpServerResponse.text("", { status: 200 })
    })
  )
