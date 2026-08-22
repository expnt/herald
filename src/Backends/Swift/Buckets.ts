import { HttpClientRequest } from "@effect/platform";
import { Effect } from "effect";
import type {
  AccessControlPolicy,
  BackendError,
  BucketInfo,
  CannedAcl,
  ListBucketsResult,
  ListObjectsResult,
  OwnerInfo,
} from "../../Services/Backend.ts";
import { BucketAlreadyOwnedByYou } from "../../Services/Backend.ts";
import {
  decodeCompactPolicy,
  defaultPolicy,
  encodeCompactPolicy,
  resolveAclInput,
} from "../../Services/Acl.ts";
import {
  formatSwiftTransportError,
  mapError,
  type SwiftTarget,
} from "./Utils.ts";
import { RESERVED_INTERNAL_PREFIXES } from "../../Services/InternalNamespace.ts";

export interface SwiftContainer {
  readonly name: string;
  readonly count: number;
  readonly bytes: number;
  readonly last_modified?: string;
}

/**
 * Canonical owner for the Swift backend. Swift has no account canonical IDs,
 * so Herald synthesizes a stable owner consistent with listBuckets.
 */
export const SWIFT_OWNER: OwnerInfo = {
  id: "swift",
  displayName: "Swift User",
};

const ACL_META_HEADER = "X-Container-Meta-S3-Acl";

const readContainerAcl = (
  client: import("@effect/platform").HttpClient.HttpClient,
  storageUrl: string,
  container: string,
  token: string,
): Effect.Effect<AccessControlPolicy | undefined, BackendError> =>
  Effect.gen(function* () {
    const response = yield* client
      .execute(
        HttpClientRequest.head(`${storageUrl}/${container}`).pipe(
          HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
        ),
      )
      .pipe(
        Effect.mapError((e) =>
          mapError(500, formatSwiftTransportError(e), container)
        ),
      );

    if (response.status < 200 || response.status >= 300) {
      const message = yield* response.text.pipe(
        Effect.orElseSucceed(() => "Error"),
      );
      return yield* Effect.fail(
        mapError(response.status, message || "Error", container, "HEAD"),
      );
    }

    const raw = response.headers[ACL_META_HEADER.toLowerCase()];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === undefined || value === "") return undefined;
    return decodeCompactPolicy(value);
  });

const writeContainerAcl = (
  client: import("@effect/platform").HttpClient.HttpClient,
  storageUrl: string,
  container: string,
  token: string,
  policy: AccessControlPolicy,
): Effect.Effect<void, BackendError> =>
  Effect.gen(function* () {
    const response = yield* client
      .execute(
        HttpClientRequest.post(`${storageUrl}/${container}`).pipe(
          HttpClientRequest.setHeaders({
            "X-Auth-Token": token,
            [ACL_META_HEADER]: encodeCompactPolicy(policy),
          }),
        ),
      )
      .pipe(
        Effect.mapError((e) =>
          mapError(500, formatSwiftTransportError(e), container)
        ),
      );

    if (response.status < 200 || response.status >= 300) {
      const message = yield* response.text.pipe(
        Effect.orElseSucceed(() => "Error"),
      );
      return yield* Effect.fail(
        mapError(response.status, message || "Error", container, "POST"),
      );
    }
  });

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
        const response = yield* client
          .execute(
            HttpClientRequest.get(`${storageUrl}?format=json`).pipe(
              HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
            ),
          )
          .pipe(
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
      headers: Record<string, string | string[] | undefined>,
    ) =>
      Effect.gen(function* () {
        // Use container from target (which is bucket_name from MaterializedBucket)
        // Don't URL-encode container name - Swift handles it natively (unlike object keys)
        const requestUrl = `${storageUrl}/${container}`;
        const response = yield* client
          .execute(
            HttpClientRequest.put(requestUrl).pipe(
              HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
            ),
          )
          .pipe(
            Effect.mapError((e) =>
              mapError(500, formatSwiftTransportError(e), container)
            ),
          );

        // Swift returns 201 (Created) for new containers, 202/204 for existing containers
        if (response.status === 201) {
          // Persist a canned ACL supplied at creation time (x-amz-acl header).
          const canned = headerValue(headers, "x-amz-acl");
          if (canned) {
            yield* writeContainerAcl(
              client,
              storageUrl,
              container,
              token,
              resolveAclInput(canned as CannedAcl, SWIFT_OWNER),
            );
          }
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
        for (const prefix of RESERVED_INTERNAL_PREFIXES) {
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
        const response = yield* client
          .execute(
            HttpClientRequest.del(`${storageUrl}/${container}`).pipe(
              HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
            ),
          )
          .pipe(
            Effect.mapError((e) =>
              mapError(500, formatSwiftTransportError(e), container)
            ),
          );

        if (response.status < 200 || response.status >= 300) {
          const message = yield* response.text.pipe(
            Effect.orElseSucceed(() => "Error"),
          );
          return yield* Effect.fail(
            mapError(response.status, message || "Error", container, "DELETE"),
          );
        }
      }),

    headBucket: (_name: string) =>
      Effect.gen(function* () {
        const response = yield* client
          .execute(
            HttpClientRequest.head(`${storageUrl}/${container}`).pipe(
              HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
            ),
          )
          .pipe(
            Effect.mapError((e) =>
              mapError(500, formatSwiftTransportError(e), container)
            ),
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

    putBucketVersioning: (_name: string, status: "Enabled" | "Suspended") =>
      Effect.gen(function* () {
        // Persist the S3 versioning state as container metadata. Swift has no
        // native versioning toggle, so Herald records the requested state and
        // reports it back on GET ?versioning.
        const response = yield* client
          .execute(
            HttpClientRequest.post(`${storageUrl}/${container}`).pipe(
              HttpClientRequest.setHeaders({
                "X-Auth-Token": token,
                "X-Container-Meta-S3-Versioning": status,
              }),
            ),
          )
          .pipe(
            Effect.mapError((e) =>
              mapError(500, formatSwiftTransportError(e), container)
            ),
          );

        if (response.status < 200 || response.status >= 300) {
          const message = yield* response.text.pipe(
            Effect.orElseSucceed(() => "Error"),
          );
          return yield* Effect.fail(
            mapError(response.status, message || "Error", container, "POST"),
          );
        }
      }),

    getBucketVersioning: (_name: string) =>
      Effect.gen(function* () {
        const response = yield* client
          .execute(
            HttpClientRequest.head(`${storageUrl}/${container}`).pipe(
              HttpClientRequest.setHeaders({ "X-Auth-Token": token }),
            ),
          )
          .pipe(
            Effect.mapError((e) =>
              mapError(500, formatSwiftTransportError(e), container)
            ),
          );

        if (response.status < 200 || response.status >= 300) {
          const message = yield* response.text.pipe(
            Effect.orElseSucceed(() => "Error"),
          );
          return yield* Effect.fail(
            mapError(response.status, message || "Error", container, "HEAD"),
          );
        }

        const raw = response.headers["x-container-meta-s3-versioning"];
        const value = Array.isArray(raw) ? raw[0] : raw;
        if (value === "Enabled" || value === "Suspended") {
          return { status: value };
        }
        return {};
      }),

    getBucketAcl: (_name: string) =>
      Effect.gen(function* () {
        const stored = yield* readContainerAcl(
          client,
          storageUrl,
          container,
          token,
        );
        return stored ?? defaultPolicy(SWIFT_OWNER);
      }),

    putBucketAcl: (_name: string, acl: AccessControlPolicy | CannedAcl) =>
      Effect.gen(function* () {
        yield* writeContainerAcl(
          client,
          storageUrl,
          container,
          token,
          resolveAclInput(acl, SWIFT_OWNER),
        );
      }),
  };
};

const headerValue = (
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined => {
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  if (!entry) return undefined;
  const value = entry[1];
  return Array.isArray(value) ? value[0] : value;
};
