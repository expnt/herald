import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { resolveBucket } from "../Utils.ts"

/**
 * A generic handler that proxies object requests to the backend.
 * This works for GET, PUT, DELETE, and HEAD since the backend proxy
 * handles the request method and body correctly.
 */
export const proxyObject = ({ path: { bucket } }: { path: { bucket: string } }) =>
  resolveBucket(bucket, (backend) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const clientResponse = yield* backend.proxy(request)
      return HttpServerResponse.raw(clientResponse, {
        status: clientResponse.status,
        headers: clientResponse.headers
      }) as HttpServerResponse.HttpServerResponse
    })
  )

