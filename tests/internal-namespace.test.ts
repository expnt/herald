import { Effect, Either } from "effect";
import {
  ensureClientReadableKey,
  ensureClientWritableKey,
  filterVisibleMultipartUploads,
  filterVisibleObjectList,
  isReservedInternalKey,
  isReservedInternalPrefix,
} from "../src/Services/InternalNamespace.ts";
import { EffectAssert, testEffect } from "./utils.ts";

testEffect("internal-namespace/prefix-matching", () =>
  Effect.gen(function* () {
    yield* EffectAssert.strictEqual(
      isReservedInternalKey(".hrld/sgmnts/a"),
      true,
    );
    yield* EffectAssert.strictEqual(
      isReservedInternalKey(".mp_segments/x"),
      true,
    );
    yield* EffectAssert.strictEqual(isReservedInternalKey(".mp_meta/x"), true);
    yield* EffectAssert.strictEqual(
      isReservedInternalKey("user/object.txt"),
      false,
    );

    yield* EffectAssert.strictEqual(isReservedInternalPrefix(".hrld/"), true);
    yield* EffectAssert.strictEqual(
      isReservedInternalPrefix(".mp_segments/"),
      true,
    );
    yield* EffectAssert.strictEqual(isReservedInternalPrefix("photos/"), false);

    const readable = yield* ensureClientReadableKey("b", ".hrld/sgmnts/1").pipe(
      Effect.either,
    );
    const writable = yield* ensureClientWritableKey(".hrld/uplds/u").pipe(
      Effect.either,
    );

    yield* EffectAssert.strictEqual(Either.isLeft(readable), true);
    yield* EffectAssert.strictEqual(Either.isLeft(writable), true);
  }));

testEffect("internal-namespace/filtering", () =>
  Effect.gen(function* () {
    const listResult = filterVisibleObjectList({
      name: "bucket",
      maxKeys: 1000,
      isTruncated: true,
      nextMarker: ".hrld/sgmnts/hidden",
      nextContinuationToken: ".mp_meta/hidden",
      listType: 2,
      contents: [
        {
          key: ".hrld/sgmnts/u/1",
          lastModified: new Date(),
          etag: "",
          size: 1,
        },
        {
          key: "visible.txt",
          lastModified: new Date(),
          etag: "",
          size: 2,
        },
      ],
      commonPrefixes: [
        { prefix: ".mp_segments/u/" },
        { prefix: "visible/" },
      ],
    });

    yield* EffectAssert.deepStrictEqual(
      listResult.contents.map((c) => c.key),
      ["visible.txt"],
    );
    yield* EffectAssert.deepStrictEqual(
      listResult.commonPrefixes.map((c) => c.prefix),
      ["visible/"],
    );
    yield* EffectAssert.strictEqual(listResult.isTruncated, false);
    yield* EffectAssert.strictEqual(listResult.keyCount, 2);

    const uploadsResult = filterVisibleMultipartUploads({
      bucket: "bucket",
      maxUploads: 1000,
      isTruncated: true,
      nextKeyMarker: ".hrld/uplds/hidden",
      uploads: [
        {
          key: ".hrld/uplds/object",
          uploadId: "u1",
          owner: { id: "1", displayName: "1" },
          initiator: { id: "1", displayName: "1" },
          storageClass: "STANDARD",
          initiated: new Date(),
        },
        {
          key: "obj.txt",
          uploadId: "u2",
          owner: { id: "1", displayName: "1" },
          initiator: { id: "1", displayName: "1" },
          storageClass: "STANDARD",
          initiated: new Date(),
        },
      ],
      commonPrefixes: [
        { prefix: ".mp_meta/x/" },
        { prefix: "visible/" },
      ],
    });

    yield* EffectAssert.deepStrictEqual(
      uploadsResult.uploads.map((u) => u.key),
      ["obj.txt"],
    );
    yield* EffectAssert.deepStrictEqual(
      uploadsResult.commonPrefixes.map((c) => c.prefix),
      ["visible/"],
    );
    yield* EffectAssert.strictEqual(uploadsResult.isTruncated, false);
  }));
