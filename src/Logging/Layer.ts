import { Config, Effect, Layer, Logger, LogLevel, Option } from "effect";

export const LoggingLive = Layer.mergeAll(
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const logLevelStr = yield* Config.option(
        Config.string("HERALD_LOG_LEVEL"),
      );

      if (Option.isNone(logLevelStr)) {
        return Logger.minimumLogLevel(LogLevel.Info);
      }

      const level = logLevelStr.value.toUpperCase();
      switch (level) {
        case "ALL":
          return Logger.minimumLogLevel(LogLevel.All);
        case "TRACE":
          return Logger.minimumLogLevel(LogLevel.Trace);
        case "DEBUG":
          return Logger.minimumLogLevel(LogLevel.Debug);
        case "INFO":
          return Logger.minimumLogLevel(LogLevel.Info);
        case "WARN":
          return Logger.minimumLogLevel(LogLevel.Warning);
        case "ERROR":
          return Logger.minimumLogLevel(LogLevel.Error);
        case "FATAL":
          return Logger.minimumLogLevel(LogLevel.Fatal);
        case "NONE":
          return Logger.minimumLogLevel(LogLevel.None);
        default:
          return Logger.minimumLogLevel(LogLevel.Info);
      }
    }),
  ),
);

/** Annotation key names used consistently across logs and spans. */
export const HERALD_KEYS = {
  algorithm: "herald_algorithm",
  bucket: "herald_bucket",
  key: "herald_key",
  uploadId: "herald_uploadId",
  error: "herald_error",
  method: "herald_method",
  operation: "herald_operation",
} as const;
