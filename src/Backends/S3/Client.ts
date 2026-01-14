import { Chunk, Context, Effect, Layer, Stream } from "effect";
import {
  HttpBody,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
  HttpMethod,
  type HttpServerRequest,
} from "@effect/platform";
import { S3Client as S3ClientSDK } from "@aws-sdk/client-s3";
import type { MaterializedBucket } from "../../Domain/Config.ts";
import { signRequestV4 } from "./Signer.ts";
import { AppConfig } from "../../Config/Layer.ts";

export class S3Client extends Context.Tag("S3Client")<
  S3Client,
  {
    readonly proxy: (
      bucket: MaterializedBucket,
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<
      HttpClientResponse.HttpClientResponse,
      HttpClientError.HttpClientError | Error,
      never
    >;
    readonly getClient: (
      bucket: MaterializedBucket,
    ) => Effect.Effect<S3ClientSDK, Error, never>;
  }
>() {}

/**
 * Headers that MUST be removed before re-signing because they relate to the
 * incoming request's signature or are added/modified by the proxy.
 */
const HEADERS_TO_STRIP = [
  "authorization",
  "x-amz-date",
  "x-amz-content-sha256",
  "x-amz-security-token",
  "x-amz-user-agent",
  "host",
  "connection",
  "content-length",
  "expect",
];

const QUERY_PARAMS_TO_STRIP = [
  "X-Amz-Algorithm",
  "X-Amz-Credential",
  "X-Amz-Date",
  "X-Amz-Expires",
  "X-Amz-SignedHeaders",
  "X-Amz-Signature",
  "X-Amz-Content-Sha256",
  "x-id",
];

export const S3ClientLive = Layer.effect(
  S3Client,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const appConfig = yield* AppConfig;

    // A simple cache for SDK clients
    const clients = new Map<string, S3ClientSDK>();

    return {
      getClient: (bucket: MaterializedBucket) =>
        Effect.gen(function* () {
          const key = `${bucket.backend_id}:${bucket.endpoint}:${bucket.region}`;
          if (clients.has(key)) {
            return clients.get(key)!;
          }

          if (bucket.endpoint === undefined) {
            return yield* Effect.fail(
              new Error(`Missing endpoint for bucket ${bucket.name}`),
            );
          }

          const sdkClient = new S3ClientSDK({
            endpoint: bucket.endpoint,
            region: bucket.region ??
              (yield* Effect.fail(
                new Error(`Missing region for bucket ${bucket.name}`),
              )),
            credentials: bucket.credentials
              ? {
                accessKeyId: bucket.credentials.accessKeyId ??
                  bucket.credentials.username ??
                  (yield* Effect.fail(
                    new Error(`Missing accessKeyId/username for bucket ${bucket.name}`),
                  )),
                secretAccessKey: bucket.credentials.secretAccessKey ??
                  bucket.credentials.password ??
                  (yield* Effect.fail(
                    new Error(
                      `Missing secretAccessKey/password for bucket ${bucket.name}`,
                    ),
                  )),
              }
              : undefined,
            forcePathStyle: true,
          });

          clients.set(key, sdkClient);
          return sdkClient;
        }),
      proxy: (bucket, request) => {
        return Effect.gen(function* () {
          yield* Effect.logInfo(
            `Proxying ${request.method} ${request.url} to bucket [${bucket.bucket_name}]`,
          );

          const url = request.url.startsWith("http")
            ? new URL(request.url)
            : new URL(
              request.url,
              `http://${
                request.headers.host ??
                (yield* Effect.fail(new Error("Missing host header")))
              }`,
            );

          const endpointUrl = new URL(
            bucket.endpoint ??
              (yield* Effect.fail(
                new Error(`Missing endpoint for bucket ${bucket.name}`),
              )),
          );

          // Calculate path
          let remainingPath = url.pathname;
          if (bucket.name && remainingPath.startsWith(`/${bucket.name}`)) {
            remainingPath = remainingPath.substring(bucket.name.length + 1);
          }
          if (!remainingPath.startsWith("/")) {
            remainingPath = "/" + remainingPath;
          }

          const destUrl = new URL(endpointUrl.toString());
          const baseP = endpointUrl.pathname === "/"
            ? ""
            : endpointUrl.pathname;
          let fullPath = `${baseP}/${bucket.bucket_name}${remainingPath}`;
          while (fullPath.includes("//")) {
            fullPath = fullPath.replace("//", "/");
          }
          // For bucket operations, avoid trailing slash
          if (
            remainingPath === "/" && fullPath.length > 1 &&
            fullPath.endsWith("/")
          ) {
            fullPath = fullPath.substring(0, fullPath.length - 1);
          }
          destUrl.pathname = fullPath;
          destUrl.search = url.search;

          for (const param of QUERY_PARAMS_TO_STRIP) {
            destUrl.searchParams.delete(param);
          }

          const headers = new Headers();
          for (const [key, value] of Object.entries(request.headers)) {
            const lowerKey = key.toLowerCase();
            if (value !== undefined && !HEADERS_TO_STRIP.includes(lowerKey)) {
              if (Array.isArray(value)) {
                value.forEach((v) => headers.append(key, v));
              } else {
                headers.set(key, value);
              }
            }
          }

          headers.set("host", destUrl.host);

          // Buffer body for re-signing
          let body: Uint8Array | undefined = undefined;
          if (request.method !== "GET" && request.method !== "HEAD") {
            const chunk = yield* Stream.runCollect(request.stream).pipe(
              Effect.catchAll((e) => Effect.die(e)),
            );
            const totalLength = Chunk.reduce(
              chunk,
              0,
              (acc, a) => acc + a.length,
            );
            body = new Uint8Array(totalLength);
            let offset = 0;
            const values = Array.from(chunk);
            for (const a of values) {
              body.set(a, offset);
              offset += a.length;
            }
          }

          const nativeReq = new Request(destUrl.toString(), {
            method: request.method,
            headers,
            body: (body as unknown as BodyInit) ?? null,
            // @ts-ignore: duplex is required by Deno/Node for request bodies but not in standard RequestInit type
            duplex: "half",
          });

          // Re-sign the request if credentials exist
          const backendConfig = appConfig.raw.backends[bucket.backend_id];
          const signedReq = (backendConfig && backendConfig.credentials)
            ? yield* signRequestV4(nativeReq, backendConfig, body)
            : nativeReq;

          if (!HttpMethod.isHttpMethod(signedReq.method)) {
            return yield* Effect.fail(
              new Error(`unrecognized http method: ${signedReq.method}`),
            );
          }

          // Convert back to HttpClientRequest
          let req = HttpClientRequest.make(signedReq.method)(signedReq.url);
          signedReq.headers.forEach((value, key) => {
            req = HttpClientRequest.setHeader(req, key, value);
          });

          if (body !== undefined) {
            const contentType = signedReq.headers.get("content-type") ??
              "application/octet-stream";
            req = HttpClientRequest.setBody(
              req,
              HttpBody.uint8Array(body, contentType),
            );
          } else if (signedReq.body) {
            const contentType = signedReq.headers.get("content-type") ??
              "application/octet-stream";
            const bodyStream = Stream.fromReadableStream(
              () => signedReq.body!,
              (e) => new Error(String(e)),
            );
            req = HttpClientRequest.setBody(
              req,
              HttpBody.stream(bodyStream, contentType),
            );
          }

          return yield* client.execute(req).pipe(
            Effect.tapErrorCause(Effect.logError),
          );
        });
      },
    };
  }),
);
