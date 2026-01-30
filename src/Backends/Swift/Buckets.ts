import { HttpClientRequest } from "@effect/platform";
import { Effect } from "effect";
import type {
  BackendError,
  BucketInfo,
  ListBucketsResult,
  ListObjectsResult,
} from "../../Services/Backend.ts";
import { BucketAlreadyOwnedByYou } from "../../Services/Backend.ts";
import {
  formatSwiftTransportError,
  mapError,
  MP_META_PREFIX,
  MP_SEGMENTS_PREFIX,
  type SwiftTarget,
} from "./Utils.ts";

export interface SwiftContainer {
  readonly name: string;
  readonly count: number;
  readonly bytes: number;
  readonly last_modified?: string;
}

export const makeBucketOps = (
  { client, container, storageUrl, token, url: _url }: SwiftTarget,
  objectOps: {
    listObjects: (args: {
      prefix?: string;
      delimiter?: string;
      marker?: string;
      maxKeys?: number;
    }) => Effect.Effect<ListObjectsResult, BackendError>;
    deleteObject: (key: string) => Effect.Effect<void, BackendError>;
  },
) => {
  return {
    listBuckets: () =>
      Effect.gen(function* () {
        const response = yield* client.execute(
          HttpClientRequest.get(`${storageUrl}?format=json`).pipe(
            HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
          ),
        ).pipe(
          Effect.mapError((e) =>
            mapError(500, formatSwiftTransportError(e), container)
          ),
        );

        if (response.status < 200 || response.status >= 300) {
          const message = yield* response.text.pipe(
            Effect.orElseSucceed(() => "Error"),
          );
          return yield* Effect.fail(
            mapError(response.status, message || "Error", container, "GET"),
          );
        }

        const containers = (yield* response.json.pipe(
          Effect.mapError((e) =>
            mapError(500, `Failed to parse Swift response: ${e}`, container)
          ),
        )) as readonly SwiftContainer[];

        const bucketInfos: BucketInfo[] = containers.map((b) => ({
          name: b.name,
          creationDate: b.last_modified
            ? new Date(b.last_modified)
            : new Date(),
        }));

        return {
          buckets: bucketInfos,
          owner: { id: "swift", displayName: "Swift User" },
        } satisfies ListBucketsResult;
      }),

    createBucket: (
      _name: string,
      _headers: Record<string, string | string[] | undefined>,
    ) =>
      Effect.gen(function* () {
        // Use container from target (which is bucket_name from MaterializedBucket)
        // Don't URL-encode container name - Swift handles it natively (unlike object keys)
        const requestUrl = `${storageUrl}/${container}`;
        const response = yield* client.execute(
          HttpClientRequest.put(requestUrl).pipe(
            HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
          ),
        ).pipe(
          Effect.mapError((e) =>
            mapError(500, formatSwiftTransportError(e), container)
          ),
        );

        // Swift returns 201 (Created) for new containers, 202/204 for existing containers
        if (response.status === 201) {
          // Successfully created
          return;
        }

        if (response.status === 202 || response.status === 204) {
          return yield* Effect.fail(
            new BucketAlreadyOwnedByYou({
              bucket: container,
              message:
                "The bucket you tried to create already exists, and you already own it.",
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

    deleteBucket: (_name: string) =>
      Effect.gen(function* () {
        // 1. Delete all segments and metadata first
        for (const prefix of [MP_SEGMENTS_PREFIX, MP_META_PREFIX]) {
          let marker: string | undefined = undefined;
          while (true) {
            const listResult: ListObjectsResult = yield* objectOps.listObjects({
              prefix,
              marker,
            });
            // Delete objects in parallel with concurrency limit
            yield* Effect.all(
              listResult.contents.map((obj) =>
                objectOps.deleteObject(obj.key).pipe(Effect.ignore)
              ),
              { concurrency: 10 },
            );
            if (!listResult.isTruncated || !listResult.nextMarker) break;
            marker = listResult.nextMarker;
          }
        }

        // 2. Delete the container itself
        const response = yield* client.execute(
          HttpClientRequest.del(`${storageUrl}/${container}`).pipe(
            HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
          ),
        ).pipe(
          Effect.mapError((e) =>
            mapError(500, formatSwiftTransportError(e), container)
          ),
        );

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

    headBucket: (_name: string) =>
      Effect.gen(function* () {
        const response = yield* client.execute(
          HttpClientRequest.head(`${storageUrl}/${container}`).pipe(
            HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
          ),
        ).pipe(
          Effect.mapError((e) =>
            mapError(500, formatSwiftTransportError(e), container)
          ),
        );

        if (response.status < 200 || response.status >= 300) {
          const message = yield* response.text.pipe(
            Effect.orElseSucceed(() => "Error"),
          );
          return yield* Effect.fail(
            mapError(
              response.status,
              message || "Error",
              container,
              "HEAD",
            ),
          );
        }
      }),
  };
};
