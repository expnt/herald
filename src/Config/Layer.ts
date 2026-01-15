import { Context, Effect, Layer, type Option } from "effect";
import { parse } from "@std/yaml";
import {
  GlobalConfig,
  lookupBucket,
  type MaterializedBucket,
} from "../Domain/Config.ts";
import { Schema } from "effect";

export class AppConfig extends Context.Tag("AppConfig")<
  AppConfig,
  {
    readonly raw: GlobalConfig;
    readonly lookupBucket: (name: string) => Option.Option<MaterializedBucket>;
  }
>() {}

export const AppConfigLive = Layer.effect(
  AppConfig,
  Effect.gen(function* () {
    const configPath = yield* Effect.succeed(
      Deno.env.get("CONFIG_PATH") ?? "herald.yaml",
    );

    const content = yield* Effect.tryPromise({
      try: () => Deno.readTextFile(configPath),
      catch: (e) =>
        new Error(`Failed to read config file at ${configPath}: ${e}`),
    });

    const yaml = yield* Effect.try({
      try: () => parse(content) as unknown,
      catch: (e) => new Error(`Failed to parse YAML: ${e}`),
    });

    const raw = yield* Schema.decodeUnknown(GlobalConfig)(yaml);

    return {
      raw,
      lookupBucket: (name: string) => lookupBucket(raw, name),
    };
  }),
);
