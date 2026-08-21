import { Cause, Effect, Exit, Layer, Option } from "effect";
import { FetchHttpClient, HttpClient, KeyValueStore } from "@effect/platform";
import { makeMultipartOps } from "../src/Backends/Swift/Multipart.ts";
import {
  MP_SEGMENTS_PREFIX,
  type SwiftTarget,
} from "../src/Backends/Swift/Utils.ts";
import { InvalidPart } from "../src/Services/Backend.ts";
import { Checksum } from "../src/Services/Checksum.ts";
import { S3HeaderService } from "../src/Services/S3HeaderService.ts";
import { EffectAssert, testEffect } from "./utils.ts";

const uploadId = "test-upload-id";
const key = "test-key";
const container = "test-container";

const makeMockStore = () =>
  KeyValueStore.make({
    get: (k) =>
      Effect.succeed(
        k === `${key}/${uploadId}` ? Option.some("{}") : Option.none(),
      ),
    getUint8Array: () => Effect.succeed(Option.none()),
    set: () => Effect.void,
    remove: () => Effect.void,
    clear: Effect.void,
    size: Effect.succeed(0),
  });

type Segment = {
  key: string;
  size: number;
  lastModified: Date;
  etag: string;
  storageClass: "STANDARD";
  owner: { id: string; displayName: string };
};

const makeSegment = (partNumber: number, size: number): Segment => ({
  key: `${MP_SEGMENTS_PREFIX}${uploadId}/${partNumber}`,
  size,
  lastModified: new Date(),
  etag: "",
  storageClass: "STANDARD",
  owner: { id: "swift", displayName: "Swift User" },
});

const makeObjectOps = (segments: Segment[]) => ({
  listObjects: () =>
    Effect.succeed({
      name: container,
      maxKeys: 1000,
      isTruncated: false,
      contents: segments,
      commonPrefixes: [],
      listType: 1 as const,
    }),
  headObject: () => Effect.die(new Error("headObject should not be called")),
});

const makeOps = (client: HttpClient.HttpClient, segments: Segment[]) =>
  Effect.gen(function* () {
    const headerService = yield* S3HeaderService;
    const checksumService = yield* Checksum;
    const target: SwiftTarget = {
      url: "http://localhost",
      token: "x",
      container,
      storageUrl: "http://localhost",
      client,
      headerService,
      checksumService,
    };
    return makeMultipartOps(target, makeMockStore(), makeObjectOps(segments));
  });

type CapturedRequest = { url: string; init: RequestInit };

const makeFetchLayer = (captured: CapturedRequest[]) =>
  Layer.succeed(FetchHttpClient.Fetch, (url, init) => {
    captured.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(new Response("", { status: 201 }));
  });

function provideLayers<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  captured: CapturedRequest[],
) {
  return effect.pipe(
    Effect.provide(S3HeaderService.Default),
    Effect.provide(Checksum.Default),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(makeFetchLayer(captured)),
  );
}

const findRequest = (
  captured: CapturedRequest[],
  method: string,
  urlPart: string,
) => captured.find((r) => r.init.method === method && r.url.includes(urlPart));

const decodeBody = (body: BodyInit | null | undefined): string => {
  if (body === null || body === undefined) return "";
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(body));
  }
  if (typeof body === "string") return body;
  return "";
};

testEffect(
  "swift multipart complete with a zero-byte part creates a plain empty object",
  () => {
    const captured: CapturedRequest[] = [];
    return provideLayers(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const multipartOps = yield* makeOps(client, [makeSegment(1, 0)]);

        const result = yield* multipartOps.completeMultipartUpload(
          key,
          uploadId,
          [{ partNumber: 1, etag: '"etag1"' }],
          {},
          {},
        );

        yield* EffectAssert.strictEqual(result.key, key);

        // Completes as a normal empty object: plain PUT, no SLO manifest params.
        const put = findRequest(captured, "PUT", `/test-key`);
        yield* EffectAssert.strictEqual(put !== undefined, true);
        if (put) {
          yield* EffectAssert.strictEqual(
            put.url.includes("multipart-manifest"),
            false,
          );
          yield* EffectAssert.strictEqual(decodeBody(put.init.body), "");
        }

        // The orphaned zero-byte segment is deleted.
        const del = findRequest(
          captured,
          "DELETE",
          `/${MP_SEGMENTS_PREFIX}${uploadId}/1`,
        );
        yield* EffectAssert.strictEqual(del !== undefined, true);
      }),
      captured,
    );
  },
);

testEffect(
  "swift multipart complete rejects a zero-byte part before a non-empty part",
  () => {
    const captured: CapturedRequest[] = [];
    return provideLayers(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const multipartOps = yield* makeOps(client, [
          makeSegment(1, 0),
          makeSegment(2, 5),
        ]);

        const exit = yield* multipartOps
          .completeMultipartUpload(
            key,
            uploadId,
            [
              { partNumber: 1, etag: '"etag1"' },
              { partNumber: 2, etag: '"etag2"' },
            ],
            {},
            {},
          )
          .pipe(Effect.exit);

        yield* EffectAssert.strictEqual(Exit.isFailure(exit), true);
        const failure = Exit.isFailure(exit)
          ? Option.getOrUndefined(Cause.failureOption(exit.cause))
          : undefined;
        yield* EffectAssert.strictEqual(failure instanceof InvalidPart, true);
        if (failure instanceof InvalidPart) {
          yield* EffectAssert.strictEqual(
            failure.message.includes("size 0"),
            true,
          );
        }
      }),
      captured,
    );
  },
);

testEffect(
  "swift multipart complete omits a trailing zero-byte part from the SLO manifest",
  () => {
    const captured: CapturedRequest[] = [];
    return provideLayers(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const multipartOps = yield* makeOps(client, [
          makeSegment(1, 100),
          makeSegment(2, 0),
        ]);

        const result = yield* multipartOps.completeMultipartUpload(
          key,
          uploadId,
          [
            { partNumber: 1, etag: '"etag1"' },
            { partNumber: 2, etag: '"etag2"' },
          ],
          {},
          {},
        );

        yield* EffectAssert.strictEqual(result.key, key);

        // SLO manifest PUT references only the non-empty segment.
        const put = findRequest(captured, "PUT", `/test-key`);
        yield* EffectAssert.strictEqual(put !== undefined, true);
        if (put) {
          yield* EffectAssert.strictEqual(
            put.url.includes("multipart-manifest"),
            true,
          );
          const manifest = JSON.parse(decodeBody(put.init.body)) as {
            path: string;
          }[];
          yield* EffectAssert.strictEqual(manifest.length, 1);
          yield* EffectAssert.strictEqual(
            manifest[0].path,
            `/${container}/${MP_SEGMENTS_PREFIX}${uploadId}/1`,
          );
        }

        // The orphaned zero-byte segment is deleted.
        const del = findRequest(
          captured,
          "DELETE",
          `/${MP_SEGMENTS_PREFIX}${uploadId}/2`,
        );
        yield* EffectAssert.strictEqual(del !== undefined, true);
      }),
      captured,
    );
  },
);
