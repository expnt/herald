import { Effect } from "effect";
import { type HttpClient, HttpClientRequest } from "@effect/platform";
import {
  BucketAlreadyOwnedByYou,
  type BucketInfo,
  type OwnerInfo,
} from "../../Services/Backend.ts";
import { mapError, type SwiftTarget } from "./Utils.ts";

export interface SwiftContainer {
  readonly name: string;
  readonly last_modified?: string;
}

export const makeBucketOps = (
  target: SwiftTarget,
  client: HttpClient.HttpClient,
) => ({
  listBuckets: () =>
    Effect.gen(function* () {
      const { storageUrl, token } = target;
      const response = yield* client.execute(
        HttpClientRequest.get(`${storageUrl}?format=json`).pipe(
          HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
        ),
      ).pipe(
        Effect.mapError((e) => mapError(500, String(e), "")),
      );

      if (response.status < 200 || response.status >= 300) {
        const message = yield* response.text.pipe(
          Effect.orElseSucceed(() => "Error"),
        );
        return yield* Effect.fail(
          mapError(response.status, message || "Error", "", "GET"),
        );
      }

      const containers = (yield* response.json.pipe(
        Effect.mapError((e) =>
          mapError(500, `Failed to parse Swift response: ${e}`, "")
        ),
      )) as readonly SwiftContainer[];

      const bucketInfos: BucketInfo[] = containers.map((b) => ({
        name: b.name,
        creationDate: b.last_modified ? new Date(b.last_modified) : undefined,
      }));

      const owner: OwnerInfo = { id: "swift", displayName: "Swift User" };

      return { buckets: bucketInfos, owner };
    }),

  createBucket: () =>
    Effect.gen(function* () {
      const { url, token, container } = target;
      const response = yield* client.execute(
        HttpClientRequest.put(url).pipe(
          HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
        ),
      ).pipe(
        Effect.mapError((e) => mapError(500, String(e), container)),
      );

      if (response.status === 201) {
        return;
      }

      if (response.status === 202) {
        return yield* Effect.fail(
          new BucketAlreadyOwnedByYou({
            bucketName: container,
            message: "Bucket already exists",
          }),
        );
      }

      if (response.status < 200 || response.status >= 300) {
        const message = yield* response.text.pipe(
          Effect.orElseSucceed(() => "Error"),
        );
        return yield* Effect.fail(
          mapError(response.status, message || "Error", container, "PUT"),
        );
      }
    }),

  deleteBucket: () =>
    Effect.gen(function* () {
      const { url, token, container } = target;
      const response = yield* client.execute(
        HttpClientRequest.del(url).pipe(
          HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
        ),
      ).pipe(
        Effect.mapError((e) => mapError(500, String(e), container)),
      );

      yield* Effect.logDebug(
        `Swift deleteBucket container=[${container}] status=${response.status}`,
      );

      if (response.status === 204) {
        return;
      }

      if (response.status < 200 || response.status >= 300) {
        const message = yield* response.text.pipe(
          Effect.orElseSucceed(() => "Error"),
        );
        return yield* Effect.fail(
          mapError(
            response.status,
            message || "Error",
            container,
            "DELETE",
          ),
        );
      }
    }),

  headBucket: () =>
    Effect.gen(function* () {
      const { url, token, container } = target;
      const response = yield* client.execute(
        HttpClientRequest.head(url).pipe(
          HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
        ),
      ).pipe(
        Effect.mapError((e) => mapError(500, String(e), container)),
      );

      if (response.status < 200 || response.status >= 300) {
        const message = yield* response.text.pipe(
          Effect.orElseSucceed(() => "Error"),
        );
        return yield* Effect.fail(
          mapError(response.status, message || "Error", container, "HEAD"),
        );
      }
    }),
});
