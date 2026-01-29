import { Config, Context, Effect, Layer, Option, Schema } from "effect";
import { parse } from "@std/yaml";
import {
  type BackendConfig,
  GlobalConfig,
  lookupBucket,
  type MaterializedBucket,
  resolveAuthConfig,
} from "../Domain/Config.ts";
import {
  type AuthCredentials,
  resolveAuthCredentials,
} from "../Services/Auth.ts";

export class HeraldConfig extends Context.Tag("HeraldConfig")<
  HeraldConfig,
  {
    readonly raw: GlobalConfig;
    readonly lookupBucket: (name: string) => Option.Option<MaterializedBucket>;
    readonly resolveAuth: (
      bucketName: string,
    ) => Option.Option<AuthCredentials[]>;
    readonly resolveAuthForBackendId: (
      backendId: string,
    ) => Option.Option<AuthCredentials[]>;
  }
>() {}

function toConfigKey(str: string): string {
  const mapping: Record<string, string> = {
    "AUTH_URL": "auth_url",
    "PROJECT_NAME": "project_name",
    "USER_DOMAIN_NAME": "user_domain_name",
    "PROJECT_DOMAIN_NAME": "project_domain_name",
    "ACCESS_KEY_ID": "accessKeyId",
    "SECRET_ACCESS_KEY": "secretAccessKey",
  };
  return mapping[str] || str.toLowerCase();
}

export function parseConfig(
  yamlConfig: unknown,
  env: Record<string, string>,
): GlobalConfig {
  const yamlBackends =
    (yamlConfig && typeof yamlConfig === "object" && "backends" in yamlConfig)
      ? (yamlConfig as { backends: Record<string, Record<string, unknown>> })
        .backends
      : {};

  const backends: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(yamlBackends)) {
    backends[k] = { ...v };
  }

  const commonKeys = [
    "PROTOCOL",
    "ENDPOINT",
    "REGION",
    "BUCKETS",
    "ACCESS_KEY_ID",
    "SECRET_ACCESS_KEY",
    "AUTH_URL",
    "CONTAINER",
    "USERNAME",
    "PASSWORD",
    "PROJECT_NAME",
    "USER_DOMAIN_NAME",
    "PROJECT_DOMAIN_NAME",
    "CORS_ALLOWED_ORIGINS",
    "CORS_ALLOWED_METHODS",
    "CORS_ALLOWED_HEADERS",
    "CORS_EXPOSED_HEADERS",
    "CORS_MAX_AGE",
    "CORS_CREDENTIALS",
    "AUTH_ACCESS_KEYS_REFS",
  ];

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("HERALD_")) continue;
    if (key === "HERALD_CONFIG_PATH") continue;
    if (key === "HERALD_LOG_LEVEL") continue;

    const parts = key.substring(7).split("_");
    let backendName: string;
    let configParts: string[];

    if (parts.length === 1 || commonKeys.includes(parts[0])) {
      backendName = "default";
      configParts = parts;
    } else {
      backendName = parts[0].toLowerCase();
      configParts = parts.slice(1);
    }

    const configKey = toConfigKey(configParts.join("_"));
    if (!backends[backendName]) backends[backendName] = {};
    const backend = backends[backendName];

    const credentialKeys = [
      "accessKeyId",
      "secretAccessKey",
      "username",
      "password",
      "project_name",
      "user_domain_name",
      "project_domain_name",
    ];

    if (credentialKeys.includes(configKey)) {
      if (!backend.credentials) {
        backend.credentials = {} as Record<string, unknown>;
      }
      (backend.credentials as Record<string, unknown>)[configKey] = value;
    } else if (configKey.startsWith("cors_")) {
      if (!backend.cors) {
        backend.cors = {} as Record<string, unknown>;
      }
      const corsKey = configKey.substring(5);
      const camelCorsKey = corsKey.replace(
        /_([a-z])/g,
        (_, g) => g.toUpperCase(),
      );

      if (
        camelCorsKey === "allowedOrigins" ||
        camelCorsKey === "allowedMethods" ||
        camelCorsKey === "allowedHeaders" || camelCorsKey === "exposedHeaders"
      ) {
        (backend.cors as Record<string, unknown>)[camelCorsKey] = value.split(
          ",",
        ).map((s) => s.trim());
      } else if (camelCorsKey === "maxAge") {
        const parsed = parseInt(value, 10);
        if (Number.isInteger(parsed) && Number.isFinite(parsed)) {
          (backend.cors as Record<string, unknown>)[camelCorsKey] = parsed;
        }
      } else if (camelCorsKey === "credentials") {
        (backend.cors as Record<string, unknown>)[camelCorsKey] =
          value.toLowerCase() === "true";
      }
    } else if (configKey === "auth_access_keys_refs") {
      backend.auth = {
        accessKeysRefs: value.split(",").map((s) => s.trim()),
      };
    } else {
      backend[configKey] = value;
    }
  }

  // Handle global CORS from env
  const globalCors: Record<string, unknown> = (yamlConfig &&
      typeof yamlConfig === "object" && "cors" in yamlConfig)
    ? { ...(yamlConfig as { cors: Record<string, unknown> }).cors }
    : {};

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("HERALD_CORS_")) continue;
    const corsKey = key.substring(12).toLowerCase();
    const camelCorsKey = corsKey.replace(
      /_([a-z])/g,
      (_, g) => g.toUpperCase(),
    );

    if (
      camelCorsKey === "allowedOrigins" || camelCorsKey === "allowedMethods" ||
      camelCorsKey === "allowedHeaders" || camelCorsKey === "exposedHeaders"
    ) {
      globalCors[camelCorsKey] = value.split(",").map((s) => s.trim());
    } else if (camelCorsKey === "maxAge") {
      const parsed = parseInt(value, 10);
      if (Number.isInteger(parsed) && Number.isFinite(parsed)) {
        globalCors[camelCorsKey] = parsed;
      }
    } else if (camelCorsKey === "credentials") {
      globalCors[camelCorsKey] = value.toLowerCase() === "true";
    }
  }

  // Handle global AUTH from env
  const globalAuth: Record<string, unknown> = (yamlConfig &&
      typeof yamlConfig === "object" && "auth" in yamlConfig)
    ? { ...(yamlConfig as { auth: Record<string, unknown> }).auth }
    : {};

  if (env["HERALD_AUTH_ACCESS_KEYS_REFS"]) {
    globalAuth["accessKeysRefs"] = env["HERALD_AUTH_ACCESS_KEYS_REFS"]
      .split(",")
      .map((s) => s.trim());
  }

  // Default backend fallback if no backends defined at all
  if (Object.keys(backends).length === 0) {
    backends["default"] = {
      protocol: "s3",
      buckets: "*",
    };
  }

  const validatedBackends: Record<string, BackendConfig> = {};
  for (const [id, b] of Object.entries(backends)) {
    if (b.protocol === "s3" || b.protocol === "swift") {
      validatedBackends[id] = b as BackendConfig;
    }
  }

  return Schema.decodeUnknownSync(GlobalConfig)({
    backends: validatedBackends,
    cors: Object.keys(globalCors).length > 0 ? globalCors : undefined,
    auth: Object.keys(globalAuth).length > 0 ? globalAuth : undefined,
  });
}

export const HeraldConfigLive = Layer.effect(
  HeraldConfig,
  Effect.gen(function* () {
    const configPath = yield* Config.string("HERALD_CONFIG_PATH").pipe(
      Config.orElse(() => Config.string("CONFIG_PATH")),
      Config.withDefault("herald.yaml"),
    );

    const yamlConfig = yield* Effect.tryPromise({
      try: () => Deno.readTextFile(configPath),
      catch: () => new Error("Config file missing"),
    }).pipe(
      Effect.flatMap((content) =>
        Effect.try({
          try: () => parse(content),
          catch: (e) => new Error(`YAML parse error: ${e}`),
        })
      ),
      Effect.orElseSucceed(() => ({ backends: {} })),
    );

    // Discovery needs the full environment. In Deno we use Deno.env.toObject().
    // We can wrap this in an Effect to be more idiomatic.
    const env = yield* Effect.sync(() => Deno.env.toObject());

    const raw = parseConfig(yamlConfig, env);

    return {
      raw,
      lookupBucket: (name: string) => lookupBucket(raw, name),
      resolveAuth: (bucketName: string) => {
        const authConfig = resolveAuthConfig(raw, bucketName);
        if (!authConfig) return Option.none();
        const creds = resolveAuthCredentials(authConfig.accessKeysRefs, env);
        return Option.some(creds);
      },
      resolveAuthForBackendId: (backendId: string) => {
        const backend = raw.backends[backendId];
        if (!backend) return Option.none();
        const authConfig = backend.auth ?? raw.auth;
        if (!authConfig) return Option.none();
        const creds = resolveAuthCredentials(authConfig.accessKeysRefs, env);
        return Option.some(creds);
      },
    };
  }),
);
