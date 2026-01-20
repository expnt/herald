import { Effect } from "effect";
import { HeraldConfig } from "../../Config/Layer.ts";
import { S3Xml } from "../../Services/S3Xml.ts";
import { resolveBackend } from "../Utils.ts";

export const listBuckets = () =>
  Effect.gen(function* () {
    const config = yield* HeraldConfig;

    // For ListBuckets, we need to decide which backend to proxy to.
    // We prefer an S3 backend if available, otherwise we take the first one.
    const backendId = Object.keys(config.raw.backends).find((id) =>
      config.raw.backends[id].protocol === "s3"
    ) ?? Object.keys(config.raw.backends)[0];

    if (!backendId) {
      const s3Xml = yield* S3Xml;
      return s3Xml.formatError("No backend configured");
    }

    return yield* resolveBackend(backendId, (backend) =>
      Effect.gen(function* () {
        const result = yield* backend.listBuckets();
        const s3xml = yield* S3Xml;
        return s3xml.formatListBuckets(result.buckets, result.owner);
      }));
  });
