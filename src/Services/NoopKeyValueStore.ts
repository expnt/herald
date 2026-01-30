import { Effect, Option } from "effect";
import { KeyValueStore } from "@effect/platform";

export const makeNoopKeyValueStore = (): KeyValueStore.KeyValueStore =>
  KeyValueStore.make({
    get: (_key) => Effect.succeed(Option.none()),
    getUint8Array: (_key) => Effect.succeed(Option.none()),
    set: (_key, _value) => Effect.void,
    remove: (_key) => Effect.void,
    clear: Effect.void,
    size: Effect.succeed(0),
  });
