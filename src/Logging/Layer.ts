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

/**
 * Utility to wrap an effect in a span and annotate all logs within it.
 */
export const withContext =
  (name: string, annotations: Record<string, string | number | boolean>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.annotateLogs(annotations),
      Effect.withSpan(name, { attributes: annotations }),
    );
