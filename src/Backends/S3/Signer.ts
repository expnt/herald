import type { HttpRequest, QueryParameterBag } from "@smithy/types";
import { Sha256 } from "@aws-crypto/sha256";
import { SignatureV4 } from "@smithy/signature-v4";
import type { BackendConfig } from "../../Domain/Config.ts";
import { Effect, Schema } from "effect";

export class S3SigningError extends Schema.TaggedError<S3SigningError>()("S3SigningError", {
    message: Schema.String
}) { }

/**
 * Returns a V4 signer for S3 requests.
 */
function getV4Signer(config: BackendConfig) {
    return Effect.gen(function* () {
        if (!config.credentials) {
            return yield* Effect.fail(new S3SigningError({ message: "No credentials found in backend config" }));
        }

        const accessKeyId = config.credentials.accessKeyId ?? config.credentials.username;
        const secretAccessKey = config.credentials.secretAccessKey ?? config.credentials.password;

        if (!accessKeyId || !secretAccessKey) {
            return yield* Effect.fail(new S3SigningError({ message: "Invalid credentials: missing accessKeyId or secretAccessKey" }));
        }

        if (!config.region) {
            return yield* Effect.fail(new S3SigningError({ message: "Missing region in backend config" }));
        }

        return new SignatureV4({
            region: config.region,
            credentials: {
                accessKeyId,
                secretAccessKey,
            },
            service: "s3",
            sha256: Sha256,
            applyChecksum: true,
        });
    });
}

/**
 * Signs the given request using AWS Signature Version 4.
 *
 * @param req - The native Request to be signed.
 * @param backend - The backend configuration.
 * @param body - Optional buffered body for signing.
 * @returns An Effect that produces a new signed native Request.
 */
export function signRequestV4(
    req: Request,
    backend: BackendConfig,
    body?: Uint8Array
): Effect.Effect<Request, S3SigningError> {
    return Effect.gen(function* () {
        const signer = yield* getV4Signer(backend);

        const reqUrl = new URL(req.url);
        const headersRecord: Record<string, string> = {};

        // We should be very conservative with unsigned headers.
        // Standard V4 signing should sign most headers.
        const unsignedHeaders = new Set([
            "accept-encoding",
            "connection",
            "user-agent",
        ]);

        req.headers.forEach((val, key) => {
            headersRecord[key.toLowerCase()] = val;
        });

        const signableReq: HttpRequest = {
            method: req.method,
            headers: headersRecord,
            path: decodeURIComponent(reqUrl.pathname),
            hostname: reqUrl.hostname,
            protocol: reqUrl.protocol,
            port: reqUrl.port ? parseInt(reqUrl.port) : undefined,
            query: getQueryParameters(req),
            body: body ?? req.body,
        };

        const signed = yield* Effect.tryPromise({
            try: () => signer.sign(signableReq, {
                unsignableHeaders: unsignedHeaders,
            }),
            catch: (e) => new S3SigningError({ message: `Failed to sign request: ${e}` })
        });

        const newReq = new Request(reqUrl, {
            method: signed.method,
            headers: signed.headers,
            body: (signed.method !== "GET" && signed.method !== "HEAD") ? signed.body : undefined,
        });

        return newReq;
    });
}

/**
 * Retrieves the query parameters from a given request.
 */
function getQueryParameters(request: Request): QueryParameterBag {
    const url = new URL(request.url);
    const params = new URLSearchParams(url.search);
    const queryParameters: QueryParameterBag = {};

    params.forEach((value, key) => {
        if (queryParameters[key]) {
            if (!Array.isArray(queryParameters[key])) {
                queryParameters[key] = [queryParameters[key] as string];
            }
            (queryParameters[key] as Array<string>).push(value);
        } else {
            queryParameters[key] = value;
        }
    });

    return queryParameters;
}
