import { Chunk, Effect, Option, Stream } from "effect";
import { KeyValueStore } from "@effect/platform";
import { SystemError } from "@effect/platform/Error";
import type { BackendService } from "./Backend.ts";

/**
 * A KeyValueStore that persists its data as objects in a BackendService.
 * This is used by backends like Swift that don't natively support S3 multipart metadata
 * persistence during the upload lifecycle.
 */
export const makeBackendKeyValueStore = (
  ops: {
    getObject: BackendService["getObject"];
    putObject: BackendService["putObject"];
    deleteObject: BackendService["deleteObject"];
  },
  prefix: string,
): KeyValueStore.KeyValueStore =>
  KeyValueStore.make({
    get: (key) => {
      return ops.getObject(`${prefix}${key}`, {}).pipe(
        Effect.flatMap((res) => Stream.runCollect(res.stream)),
        Effect.map((chunks) => {
          const totalLength = Chunk.reduce(
            chunks,
            0,
            (acc, chunk) => acc + chunk.length,
          );
          const all = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of chunks) {
            all.set(chunk, offset);
            offset += chunk.length;
          }
          return Option.some(new TextDecoder().decode(all));
        }),
        Effect.catchTag("NoSuchKey", () => Effect.succeed(Option.none())),
        Effect.catchAll((e) =>
          Effect.fail(
            new SystemError({
              module: "KeyValueStore",
              method: "get",
              reason: "Unknown",
              syscall: "getObject",
              description: String(e),
              cause: e,
            }),
          )
        ),
      );
    },
    getUint8Array: (key) => {
      return ops.getObject(`${prefix}${key}`, {}).pipe(
        Effect.flatMap((res) => Stream.runCollect(res.stream)),
        Effect.map((chunks) => {
          const totalLength = Chunk.reduce(
            chunks,
            0,
            (acc, chunk) => acc + chunk.length,
          );
          const all = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of chunks) {
            all.set(chunk, offset);
            offset += chunk.length;
          }
          return Option.some(all);
        }),
        Effect.catchTag("NoSuchKey", () => Effect.succeed(Option.none())),
        Effect.catchAll((e) =>
          Effect.fail(
            new SystemError({
              module: "KeyValueStore",
              method: "getUint8Array",
              reason: "Unknown",
              syscall: "getObject",
              description: String(e),
              cause: e,
            }),
          )
        ),
      );
    },
    set: (key, value) => {
      const encodedValue = typeof value === "string"
        ? new TextEncoder().encode(value)
        : value;
      return ops.putObject(
        `${prefix}${key}`,
        Stream.succeed(encodedValue),
        { "Content-Type": "application/json" },
      ).pipe(
        Effect.asVoid,
        Effect.catchAll((e) =>
          Effect.fail(
            new SystemError({
              module: "KeyValueStore",
              method: "set",
              reason: "Unknown",
              syscall: "putObject",
              description: String(e),
              cause: e,
            }),
          )
        ),
      );
    },
    remove: (key) =>
      ops.deleteObject(`${prefix}${key}`).pipe(
        Effect.catchAll((e) =>
          Effect.fail(
            new SystemError({
              module: "KeyValueStore",
              method: "remove",
              reason: "Unknown",
              syscall: "deleteObject",
              description: String(e),
              cause: e,
            }),
          )
        ),
      ),
    clear: Effect.die("Clear not supported in BackendKeyValueStore"),
    size: Effect.die("Size not supported in BackendKeyValueStore"),
  });
