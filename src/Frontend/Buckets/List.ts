import { Effect } from "effect";
import { HeraldConfig } from "../../Config/Layer.ts";
import { BackendResolver } from "../../Services/BackendResolver.ts";
import { S3Xml } from "../../Services/S3Xml.ts";

export const listBuckets = Effect.gen(function* () {
  const config = yield* HeraldConfig;
  const resolver = yield* BackendResolver;

  // For ListBuckets, we need to decide which backend to proxy to.
  // We prefer an S3 backend if available, otherwise we take the first one.
  const backendId = Object.keys(config.raw.backends).find((id) =>
    config.raw.backends[id].protocol === "s3"
  ) ?? Object.keys(config.raw.backends)[0];

  if (!backendId) {
    const s3Xml = yield* S3Xml;
    return s3Xml.formatError("No backend configured");
  }
  const s3xml = yield* S3Xml;
  return yield* resolver.getLayerForBackend(backendId).pipe(
    Effect.andThen((backend) =>
      backend.listBuckets()
    ),
    Effect.andThen(({ buckets, owner }) =>
      s3xml.formatListBuckets(buckets, owner)
    ),
    Effect.catchAll((error) => Effect.succeed(s3xml.formatError(error))),
  );
});
