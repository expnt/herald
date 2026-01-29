import {
  HttpApiBuilder,
  HttpRouter,
  HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer } from "effect";
import { Backend, MethodNotAllowed } from "../Services/Backend.ts";
import { BackendResolver } from "../Services/BackendResolver.ts";
import { S3Xml } from "../Services/S3Xml.ts";
import { RequestContext } from "./Utils.ts";
import { listObjects } from "./Objects/List.ts";
import { postObject } from "./Objects/Post.ts";
import { getObject } from "./Objects/Get.ts";
import { putObject } from "./Objects/Put.ts";
import { deleteObject } from "./Objects/Delete.ts";
import { headObject } from "./Objects/Head.ts";
import { createBucket } from "./Buckets/Create.ts";
import { deleteBucket } from "./Buckets/Delete.ts";
import { headBucket } from "./Buckets/Head.ts";
import { HttpHeraldApi } from "../Api.ts";
import { BadGateway } from "./Api.ts";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";

/**
 * Main HTTP Router for the S3 Proxy.
 */
export const makeS3Router = (prefix = "") =>
  Effect.gen(function* () {
    const s3Xml = yield* S3Xml;
    const resolver = yield* BackendResolver;

    const frontHandler = <R, E>(
      handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
    ) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        // Extract bucket name from URL path
        // request.url might be a full URL or just a pathname
        const pathname = request.url.startsWith("http")
          ? new URL(request.url).pathname
          : request.url.split("?")[0]; // Remove query string if present

        // Remove prefix from pathname before extracting bucket
        let pathWithoutPrefix = pathname;
        if (prefix) {
          // Normalize prefix: ensure it starts with / and remove trailing /
          const normalizedPrefix = prefix.startsWith("/")
            ? prefix
            : `/${prefix}`;
          const cleanPrefix = normalizedPrefix.endsWith("/")
            ? normalizedPrefix.slice(0, -1)
            : normalizedPrefix;

          // Check if pathname starts with the prefix (exact match)
          if (pathname.startsWith(cleanPrefix)) {
            pathWithoutPrefix = pathname.substring(cleanPrefix.length);
            // Ensure it starts with / after prefix removal
            if (!pathWithoutPrefix.startsWith("/")) {
              pathWithoutPrefix = `/${pathWithoutPrefix}`;
            }
          }
        }

        const bucket = pathWithoutPrefix.split("/").filter(Boolean)[0] || "";
        const isHead = request.method === "HEAD";

        const backend = yield* resolver.getLayerForBucket(bucket);
        const backendLayer = Layer.succeed(Backend, backend);

        return yield* handler.pipe(
          Effect.provideService(RequestContext, { bucket }),
          Effect.provide(backendLayer),
          // convert the frontend errors to xml
          Effect.catchAll((err) => {
            return Effect.succeed(s3Xml.formatError(err, isHead));
          }),
        );
      });

    const router = HttpRouter.empty
      .pipe(
        HttpRouter.get(
          "/health",
          HttpServerResponse.json({ status: "ok" }),
        ),
        // List Buckets (GET /)
        HttpRouter.get(
          "/",
          Effect.gen(function* () {
            const backendInstance = yield* resolver.getLayerForBucket("");
            const backendLayer = Layer.succeed(Backend, backendInstance);
            const result = yield* Effect.gen(function* () {
              const backend = yield* Backend;
              return yield* backend.listBuckets();
            }).pipe(Effect.provide(backendLayer));
            return s3Xml.formatListBuckets(result.buckets, result.owner);
          }).pipe(
            Effect.catchAll((err: unknown) =>
              Effect.succeed(s3Xml.formatError(err))
            ),
          ),
        ),
        // Bucket/Object operations
        HttpRouter.all(
          "/:bucket",
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            if (request.method === "GET") {
              return yield* frontHandler(listObjects);
            }
            if (request.method === "PUT") {
              return yield* frontHandler(createBucket);
            }
            if (request.method === "DELETE") {
              return yield* frontHandler(deleteBucket);
            }
            if (request.method === "HEAD") {
              return yield* frontHandler(headBucket);
            }
            if (request.method === "POST") {
              return yield* frontHandler(postObject);
            }
            return yield* Effect.fail(
              new MethodNotAllowed({
                message:
                  `Method ${request.method} not implemented for bucket operations`,
              }),
            );
          }),
        ),
        HttpRouter.all(
          "/:bucket/*",
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            if (request.method === "GET") return yield* frontHandler(getObject);
            if (request.method === "PUT") return yield* frontHandler(putObject);
            if (request.method === "POST") {
              return yield* frontHandler(postObject);
            }
            if (request.method === "DELETE") {
              return yield* frontHandler(deleteObject);
            }
            if (request.method === "HEAD") {
              return yield* frontHandler(headObject);
            }
            return yield* Effect.fail(
              new MethodNotAllowed({
                message: `Method ${request.method} not implemented`,
              }),
            );
          }),
        ),
      );

    return prefix
      ? HttpRouter.empty.pipe(HttpRouter.mount(
        prefix.startsWith("/")
          ? prefix as `/${string}`
          : `/${prefix}` as `/${string}`,
        router,
      ))
      : router;
  });

export const HttpS3Live = Layer.unwrapEffect(
  Effect.gen(function* () {
    const router = yield* makeS3Router();
    return HttpApiBuilder.group(HttpHeraldApi, "s3", (handlers) => {
      const handler = (
        req: { readonly request: HttpServerRequest.HttpServerRequest },
      ) =>
        router.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            req.request,
          ),
          Effect.catchAll((err) =>
            Effect.fail(new BadGateway({ message: String(err) }))
          ),
        ) as Effect.Effect<
          HttpServerResponse.HttpServerResponse,
          BadGateway,
          never
        >;
      return handlers.handleRaw("postRoot", handler)
        .handleRaw("listBuckets", handler)
        .handleRaw("listObjects", handler)
        .handleRaw("createBucket", handler)
        .handleRaw("deleteBucket", handler)
        .handleRaw("headBucket", handler)
        .handleRaw("postBucket", handler)
        .handleRaw("getObject", handler)
        .handleRaw("putObject", handler)
        .handleRaw("postObject", handler)
        .handleRaw("deleteObject", handler)
        .handleRaw("headObject", handler);
    });
  }),
);
