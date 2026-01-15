import { Effect } from "effect";
import { AppConfig } from "../../Config/Layer.ts";
import { S3Xml } from "../../Services/S3Xml.ts";
import { resolveBackend } from "../Utils.ts";

export const listBuckets = () =>
  Effect.gen(function* () {
    const config = yield* AppConfig;

    // For ListBuckets, we need to decide which backend to proxy to.
    const s3BackendId = Object.keys(config.raw.backends).find((id) =>
      config.raw.backends[id].protocol === "s3"
    );

    if (!s3BackendId) {
      const s3Xml = yield* S3Xml;
      return s3Xml.formatError("No S3 backend configured");
    }

    return yield* resolveBackend(s3BackendId, (backend) =>
      Effect.gen(function* () {
        const result = yield* backend.listBuckets();
        const s3xml = yield* S3Xml;
        return s3xml.formatListBuckets(result.buckets, result.owner);
      }));
  });
