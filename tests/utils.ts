import { S3Client } from "@aws-sdk/client-s3";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpApiBuilder, HttpServer } from "@effect/platform";
import { ApiLive } from "../src/Http.ts";
import { AppConfig } from "../src/Config/Layer.ts";
import { S3XmlLive } from "../src/Services/S3Xml.ts";
import { BackendResolverLive } from "../src/Services/BackendResolver.ts";
import { S3ClientLive } from "../src/Backends/S3/Client.ts";
import { type GlobalConfig, lookupBucket } from "../src/Domain/Config.ts";
// deno-lint-ignore no-external-import
import assert from "node:assert";
import { assertSnapshot } from "@std/testing/snapshot";

export const EffectAssert = {
    strictEqual: <A>(actual: A, expected: A, message?: string) =>
        Effect.sync(() => assert.strictEqual(actual, expected, message)),
    deepStrictEqual: <A>(actual: A, expected: A, message?: string) =>
        Effect.sync(() => assert.deepStrictEqual(actual, expected, message)),
    fail: (message?: string) => Effect.sync(() => assert.fail(message)),
    snapshot: (
        t: Deno.TestContext,
        value: unknown,
        options?: { name: string },
    ) =>
        Effect.tryPromise(() =>
            assertSnapshot(t, value, options as { name: string })
        ),
};

export { assert };

export interface TestHarness {
    readonly proxyUrl: string;
    readonly minioUrl: string;
    readonly client: S3Client;
    readonly proxyClient: S3Client;
    readonly getLastResponse: () => Snapshot | undefined;
}

export interface Snapshot {
    status: number;
    headers: Record<string, string>;
    body: string;
}

/**
 * Normalizes metadata for comparison.
 */
export function normalizeMetadata(snapshot: Snapshot) {
    // Normalize headers for comparison (lowercase and filter out dynamic ones)
    const normalizedHeaders: Record<string, string> = {};
    const skipHeaders = new Set([
        "date",
        "x-amz-request-id",
        "x-amz-id-2",
        "server",
        "content-length",
        "connection",
        "authorization",
        "x-amz-content-sha256",
        "x-amz-date",
        "accept-ranges",
        "strict-transport-security",
        "x-content-type-options",
        "x-ratelimit-limit",
        "x-ratelimit-remaining",
        "x-xss-protection",
        "x-minio-error-code",
        "x-minio-error-desc",
        "vary",
    ]);
    for (const [k, v] of Object.entries(snapshot.headers)) {
        const lowerK = k.toLowerCase();
        if (!skipHeaders.has(lowerK)) {
            normalizedHeaders[lowerK] = v;
        }
    }

    return {
        status: snapshot.status,
        headers: normalizedHeaders,
    };
}

/**
 * Normalizes XML body for comparison.
 */
export function normalizeXml(body: string): string {
    // Replace dynamic XML fields with placeholders
    let normalized = body;
    normalized = normalized.replace(
        /<RequestId>[^<]+<\/RequestId>/g,
        "<RequestId>PLACEHOLDER</RequestId>",
    );
    normalized = normalized.replace(
        /<HostId>[^<]+<\/HostId>/g,
        "<HostId>PLACEHOLDER</HostId>",
    );
    normalized = normalized.replace(
        /<CreationDate>[^<]+<\/CreationDate>/g,
        "<CreationDate>PLACEHOLDER</CreationDate>",
    );
    normalized = normalized.replace(/<ID>[^<]+<\/ID>/g, "<ID>PLACEHOLDER</ID>");
    normalized = normalized.replace(
        /<DisplayName>[^<]+<\/DisplayName>/g,
        "<DisplayName>PLACEHOLDER</DisplayName>",
    );

    // Normalize whitespace between tags
    normalized = normalized.replace(/>\s+</g, "><").trim();

    return normalized;
}

/**
 * Creates a test harness that starts an in-process Herald proxy on a random port.
 */
export const makeTestHarness = (config: GlobalConfig) =>
    Effect.gen(function* () {
        const AppConfigLive = Layer.succeed(AppConfig, {
            raw: config,
            lookupBucket: (name: string) => lookupBucket(config, name),
        });

        const ApiWithRequirements = ApiLive.pipe(
            Layer.provide(BackendResolverLive),
            Layer.provide(S3ClientLive),
            Layer.provide(S3XmlLive),
            Layer.provide(AppConfigLive),
            Layer.provide(FetchHttpClient.layer),
            Layer.provideMerge(HttpServer.layerContext),
        );

        // In @effect/platform 0.90.x, toWebHandler returns the object directly, not an Effect.
        const webHandler = HttpApiBuilder.toWebHandler(ApiWithRequirements);

        // Start Deno.serve on a random port
        const server = Deno.serve(
            { port: 0, onListen: () => { } },
            (req) => webHandler.handler(req),
        );

        // Ensure cleanup
        yield* Effect.addFinalizer(() =>
            Effect.tryPromise({
                try: () => server.shutdown(),
                catch: (e) => new Error(`Server shutdown failed: ${e}`),
            }).pipe(Effect.orDie)
        );
        yield* Effect.addFinalizer(() =>
            Effect.tryPromise({
                try: () => webHandler.dispose(),
                catch: (e) => new Error(`Web handler disposal failed: ${e}`),
            }).pipe(Effect.orDie)
        );

        const proxyUrl = `http://localhost:${server.addr.port}`;
        const minioUrl = "http://localhost:9000";

        const credentials = {
            accessKeyId: "minioadmin",
            secretAccessKey: "minioadmin",
        };

        let lastResponse: Snapshot | undefined;

        // Custom fetch to capture response
        const capturingFetch = async (
            url: string | URL | Request,
            init?: RequestInit,
        ) => {
            const res = await fetch(url, init);
            const hasBody = res.status !== 204 && res.status !== 205 &&
                res.status !== 304;
            let body = "";
            if (hasBody) {
                body = await res.text();
            }
            const headers: Record<string, string> = {};
            res.headers.forEach((v, k) => {
                headers[k] = v;
            });

            lastResponse = {
                status: res.status,
                headers,
                body,
            };

            // Return a new response because we consumed the body
            return new Response(hasBody ? body : null, {
                status: res.status,
                statusText: res.statusText,
                headers: res.headers,
            });
        };

        const createRequestHandler = () => ({
            handle: async (request: {
                query?: Record<string, string>;
                protocol: string;
                hostname: string;
                port?: number;
                path: string;
                method: string;
                headers: Record<string, string>;
                body?: BodyInit;
            }) => {
                const queryStr =
                    (request.query && Object.keys(request.query).length > 0)
                        ? "?" +
                        Object.entries(request.query).map(([k, v]) => `${k}=${v}`).join(
                            "&",
                        )
                        : "";
                const url = `${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ""
                    }${request.path}${queryStr}`;
                const res = await capturingFetch(url, {
                    method: request.method,
                    headers: request.headers,
                    body: request.body,
                    // @ts-ignore: duplex is required for streaming body in fetch
                    duplex: "half",
                });

                const responseHeaders: Record<string, string> = {};
                res.headers.forEach((v, k) => {
                    responseHeaders[k] = v;
                });

                return {
                    response: {
                        statusCode: res.status,
                        headers: responseHeaders,
                        body: res.body,
                    },
                };
            },
        });

        const client = new S3Client({
            endpoint: minioUrl,
            region: "us-east-1",
            credentials,
            forcePathStyle: true,
            requestHandler: createRequestHandler(),
        });

        const proxyClient = new S3Client({
            endpoint: proxyUrl,
            region: "us-east-1",
            credentials,
            forcePathStyle: true,
            requestHandler: createRequestHandler(),
        });

        return {
            proxyUrl,
            minioUrl,
            client,
            proxyClient,
            getLastResponse: () => lastResponse,
        };
    });

/**
 * Runs an Effect as a Deno test.
 */
export const testEffect = <E>(
    name: string,
    effect: (t: Deno.TestContext) => Effect.Effect<void, E, never>,
    options?: Omit<Deno.TestDefinition, "name" | "fn">,
) => {
    Deno.test({
        ...options,
        name,
        fn: async (t) => {
            await Effect.runPromiseExit(effect(t));
        },
    });
};

export type ProxyTestCase = {
    name: string;
    config: GlobalConfig;
    fn: (
        client: S3Client,
    ) => Promise<void> | Effect.Effect<void, unknown, never>;
    beforeAll?: (client: S3Client) => Promise<void> | Effect.Effect<void, unknown, never>;
    afterAll?: (client: S3Client) => Promise<void> | Effect.Effect<void, unknown, never>;
    ignore?: boolean;
    only?: boolean;
};

function baselineRunner(tc: ProxyTestCase, t: Deno.TestContext) {
    return Effect.gen(function* () {
        const h = yield* makeTestHarness(tc.config);

        if (tc.beforeAll) {
            const beforeResult = tc.beforeAll(h.client);
            if (Effect.isEffect(beforeResult)) {
                yield* beforeResult;
            } else {
                yield* Effect.tryPromise(() => beforeResult as Promise<void>).pipe(Effect.orDie);
            }
        }

        const resultEffect = Effect.gen(function* () {
            const result = tc.fn(h.client);
            if (Effect.isEffect(result)) {
                yield* result;
            } else {
                yield* Effect.tryPromise({
                    try: () => result as Promise<void>,
                    catch: (e) =>
                        new Error(`Baseline test function failed for ${tc.name}: ${e}`),
                });
            }
        });

        yield* resultEffect;

        const snapshot = h.getLastResponse();
        if (snapshot) {
            const metadata = normalizeMetadata(snapshot);
            yield* EffectAssert.snapshot(t, metadata, { name: `${t.name} metadata` });
            if (snapshot.body) {
                const xml = normalizeXml(snapshot.body);
                yield* EffectAssert.snapshot(t, xml, { name: `${t.name} body` });
            }
        }

        if (tc.afterAll) {
            const afterResult = tc.afterAll(h.client);
            if (Effect.isEffect(afterResult)) {
                yield* afterResult;
            } else {
                yield* Effect.tryPromise(() => afterResult as Promise<void>).pipe(Effect.orDie);
            }
        }
    }).pipe(
        Effect.tapErrorCause(Effect.logError),
        Effect.scoped,
    );
}

function proxyRunner(tc: ProxyTestCase, t: Deno.TestContext) {
    return Effect.gen(function* () {
        const h = yield* makeTestHarness(tc.config);

        if (tc.beforeAll) {
            const beforeResult = tc.beforeAll(h.proxyClient);
            if (Effect.isEffect(beforeResult)) {
                yield* beforeResult;
            } else {
                yield* Effect.tryPromise(() => beforeResult as Promise<void>).pipe(Effect.orDie);
            }
        }

        const resultEffect = Effect.gen(function* () {
            const result = tc.fn(h.proxyClient);
            if (Effect.isEffect(result)) {
                yield* result;
            } else {
                yield* Effect.tryPromise({
                    try: () => result as Promise<void>,
                    catch: (e) => new Error(`Test function failed for ${tc.name}: ${e}`),
                });
            }
        });

        yield* resultEffect;

        const snapshot = h.getLastResponse();
        if (snapshot) {
            const metadata = normalizeMetadata(snapshot);
            yield* EffectAssert.snapshot(t, metadata, { name: `${t.name} metadata` });
            if (snapshot.body) {
                const xml = normalizeXml(snapshot.body);
                yield* EffectAssert.snapshot(t, xml, { name: `${t.name} body` });
            }
        }

        if (tc.afterAll) {
            const afterResult = tc.afterAll(h.proxyClient);
            if (Effect.isEffect(afterResult)) {
                yield* afterResult;
            } else {
                yield* Effect.tryPromise(() => afterResult as Promise<void>).pipe(Effect.orDie);
            }
        }
    }).pipe(
        Effect.tapErrorCause(Effect.logError),
        Effect.scoped,
    );
}

/**
 * Generic harness for running proxy tests against both a baseline (MinIO)
 * and the Herald proxy itself.
 */
export function harness(cases: ProxyTestCase[]) {
    for (const tc of cases) {
        testEffect(`Baseline/${tc.name}`, (t) => baselineRunner(tc, t), {
            ignore: tc.ignore,
            only: tc.only,
        });
        testEffect(`Proxy/${tc.name}`, (t) => proxyRunner(tc, t), {
            ignore: tc.ignore,
            only: tc.only,
        });
    }
}
