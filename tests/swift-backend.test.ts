import { Cause, Effect, Exit, Layer, Option, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpServerError,
  HttpServerRequest,
  KeyValueStore,
} from "@effect/platform";
import { makeMultipartOps } from "../src/Backends/Swift/Multipart.ts";
import {
  causeChainHasClientDisconnect,
  CLIENT_DISCONNECT_MESSAGE,
  type SwiftTarget,
} from "../src/Backends/Swift/Utils.ts";
import { makeObjectOps } from "../src/Backends/Swift/Objects.ts";
import { InternalError, InvalidRequest } from "../src/Services/Backend.ts";
import { Checksum } from "../src/Services/Checksum.ts";
import { S3HeaderService } from "../src/Services/S3HeaderService.ts";
import { assert, assertEquals, EffectAssert, testEffect } from "./utils.ts";

const container = "test-container";

type CapturedRequest = { url: string; init: RequestInit };

const headerValue = (
  init: RequestInit,
  name: string,
): string | undefined => {
  const headers = new Headers(init.headers);
  return headers.get(name) ?? undefined;
};

const makeFetchLayer = (
  handler: (url: string, init: RequestInit) => Promise<Response>,
) =>
  Layer.succeed(
    FetchHttpClient.Fetch,
    (url, init) => handler(String(url), init ?? {}),
  );

const provideLayers = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  handler: (url: string, init: RequestInit) => Promise<Response>,
) =>
  effect.pipe(
    Effect.provide(S3HeaderService.Default),
    Effect.provide(Checksum.Default),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(makeFetchLayer(handler)),
  );

const makeObjectTarget = (client: HttpClient.HttpClient) =>
  Effect.gen(function* () {
    const headerService = yield* S3HeaderService;
    const checksumService = yield* Checksum;
    const target: SwiftTarget = {
      url: "http://swift.test",
      token: "x",
      container,
      storageUrl: "http://swift.test",
      client,
      headerService,
      checksumService,
    };
    return makeObjectOps(target);
  });

const makeMultipartTarget = (client: HttpClient.HttpClient) =>
  Effect.gen(function* () {
    const headerService = yield* S3HeaderService;
    const checksumService = yield* Checksum;
    const target: SwiftTarget = {
      url: "http://swift.test",
      token: "x",
      container,
      storageUrl: "http://swift.test",
      client,
      headerService,
      checksumService,
    };
    const store = KeyValueStore.make({
      get: () => Effect.succeed(Option.none()),
      getUint8Array: () => Effect.succeed(Option.none()),
      set: () => Effect.void,
      remove: () => Effect.void,
      clear: Effect.void,
      size: Effect.succeed(0),
    });
    return makeMultipartOps(target, store, {
      listObjects: () =>
        Effect.succeed({
          name: container,
          maxKeys: 1000,
          isTruncated: false,
          contents: [],
          commonPrefixes: [],
          listType: 1 as const,
        }),
      headObject: () =>
        Effect.die(new Error("headObject should not be called")),
    });
  });

// ---------------------------------------------------------------------------
// BUG 1: outbound Content-Length must reflect the decoded payload size when
// AWS streaming framing is present, not the inbound wire length.
// ---------------------------------------------------------------------------

const contentLengthCases: {
  name: string;
  headers: Record<string, string>;
  bodyBytes: number;
  expected: string | undefined;
}[] = [
  {
    name: "plain content-length PUT declares the inbound length",
    headers: { "content-length": "11" },
    bodyBytes: 11,
    expected: "11",
  },
  {
    name: "aws-chunked PUT declares the decoded length",
    headers: {
      "content-encoding": "aws-chunked",
      "content-length": "30",
      "x-amz-decoded-content-length": "11",
    },
    bodyBytes: 11,
    expected: "11",
  },
  {
    name: "STREAMING-* sha256 PUT declares the decoded length",
    headers: {
      "x-amz-content-sha256": "STREAMING-UNSIGNED-PAYLOAD-TRAILER",
      "content-length": "30",
      "x-amz-decoded-content-length": "7",
    },
    bodyBytes: 7,
    expected: "7",
  },
  {
    name: "no length headers means no outbound Content-Length",
    headers: {},
    bodyBytes: 4,
    expected: undefined,
  },
];

for (const tc of contentLengthCases) {
  testEffect(`swift putObject ${tc.name}`, () => {
    const captured: CapturedRequest[] = [];
    return provideLayers(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const ops = yield* makeObjectTarget(client);
        const body = new Uint8Array(tc.bodyBytes).fill(0x61);
        yield* ops.putObject(
          "some-key",
          Stream.make(body),
          tc.headers,
        );
        assertEquals(captured.length, 1, "expected exactly one Swift request");
        assertEquals(
          headerValue(captured[0].init, "content-length"),
          tc.expected,
        );
      }),
      (_url, _init) => {
        captured.push({ url: _url, init: _init });
        return Promise.resolve(new Response("", { status: 201 }));
      },
    );
  });
}

// ---------------------------------------------------------------------------
// BUG 2: a mid-flight transport failure must NOT be retried by replaying the
// already-consumed body stream.
// ---------------------------------------------------------------------------

testEffect(
  "swift uploadPart does not retry after a transport failure",
  () => {
    let attempts = 0;
    return provideLayers(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const ops = yield* makeMultipartTarget(client);
        const result = yield* Effect.either(
          ops.uploadPart(
            "some-key",
            "upload-1",
            1,
            Stream.make(new Uint8Array(8).fill(1)),
            {},
          ),
        );
        assertEquals(attempts, 1, "PUT must not be retried");
        if (!(result._tag === "Left" && result.left instanceof InternalError)) {
          throw new Error(`expected InternalError, got ${result}`);
        }
      }),
      () => {
        attempts += 1;
        return Promise.reject(
          new Error("Transport error (PUT http://swift.test)"),
        );
      },
    );
  },
);

// ---------------------------------------------------------------------------
// BUG 3: client disconnects map to a distinct non-500 error, not InternalError.
// ---------------------------------------------------------------------------

const makeFakeServerRequest = (): HttpServerRequest.HttpServerRequest =>
  HttpServerRequest.fromWeb(
    new Request("http://client.test/upload", { method: "PUT" }),
  );

const makeRealInboundDisconnectError = () =>
  new HttpServerError.RequestError({
    request: makeFakeServerRequest(),
    reason: "Decode",
    cause: new Error("terminated"),
  });

const wrapCause = (error: Error, cause: unknown): Error => {
  (error as { cause?: unknown }).cause = cause;
  return error;
};

const failureFromExit = <A, E>(
  exit: Exit.Exit<A, E>,
): unknown => {
  if (Exit.isSuccess(exit)) {
    throw new Error("expected the effect to fail, but it succeeded");
  }
  const failure = Cause.failureOption(exit.cause);
  if (Option.isNone(failure)) {
    throw new Error("expected a failure value on the error cause");
  }
  return failure.value;
};

testEffect(
  "inbound RequestError(Decode) is recognized as a client disconnect",
  () => {
    const real = makeRealInboundDisconnectError();
    return Effect.gen(function* () {
      yield* EffectAssert.strictEqual(
        causeChainHasClientDisconnect(real),
        true,
      );
      yield* EffectAssert.strictEqual(
        causeChainHasClientDisconnect(new Error("unrelated failure")),
        false,
      );
      const undiciStyle = wrapCause(
        new TypeError("error sending request from 10.0.0.1:1234"),
        wrapCause(
          new Error(
            "client error (SendRequest): error from user's Body stream",
          ),
          real,
        ),
      );
      yield* EffectAssert.strictEqual(
        causeChainHasClientDisconnect(undiciStyle),
        true,
      );
    });
  },
);

testEffect(
  "putObject maps an inbound client abort to InvalidRequest instead of InternalError",
  () => {
    return provideLayers(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const ops = yield* makeObjectTarget(client);
        const exit = yield* Effect.exit(
          ops.putObject(
            "some-key",
            Stream.fail(makeRealInboundDisconnectError()),
            { "content-length": "100" },
          ),
        );
        const err = failureFromExit(exit);
        if (!(err instanceof InvalidRequest)) {
          throw new Error(`expected InvalidRequest, got ${err}`);
        }
        assertEquals(err.message, CLIENT_DISCONNECT_MESSAGE);
      }),
      () => Promise.resolve(new Response("", { status: 201 })),
    );
  },
);

testEffect(
  "uploadPart maps a disconnect wrapped by the transport layer to InvalidRequest",
  () => {
    return provideLayers(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const ops = yield* makeMultipartTarget(client);
        const exit = yield* Effect.exit(
          ops.uploadPart(
            "some-key",
            "upload-1",
            1,
            Stream.make(new Uint8Array(8).fill(1)),
            {},
          ),
        );
        const err = failureFromExit(exit);
        if (!(err instanceof InvalidRequest)) {
          throw new Error(`expected InvalidRequest, got ${err}`);
        }
        assertEquals(err.message, CLIENT_DISCONNECT_MESSAGE);
      }),
      () => {
        const disconnect = new InvalidRequest({
          message: CLIENT_DISCONNECT_MESSAGE,
        });
        const sendRequestError = new Error(
          "client error (SendRequest): error from user's Body stream",
        );
        (sendRequestError as { cause?: unknown }).cause = disconnect;
        const transportError = new TypeError(
          "error sending request from 10.0.0.1:1234",
        );
        (transportError as { cause?: unknown }).cause = sendRequestError;
        return Promise.reject(transportError);
      },
    );
  },
);

testEffect(
  "non-disconnect transport failures still map to InternalError",
  () => {
    return provideLayers(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const ops = yield* makeMultipartTarget(client);
        const exit = yield* Effect.exit(
          ops.uploadPart(
            "some-key",
            "upload-1",
            1,
            Stream.make(new Uint8Array(8).fill(1)),
            {},
          ),
        );
        const err = failureFromExit(exit);
        assert(err instanceof InternalError);
      }),
      () =>
        Promise.reject(new Error("ECONNRESET while sending request headers")),
    );
  },
);

// Keep Exit import referenced for future exit-based assertions.
void Exit;
