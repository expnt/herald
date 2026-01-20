#!/usr/bin/env -S deno run --allow-all

import { Effect } from "effect";
import { LoggingLive } from "../src/Logging/Layer.ts";
import { makeTestHarness } from "../tests/utils.ts";
import type { GlobalConfig } from "../src/Domain/Config.ts";
import * as path from "@std/path";
import { $ } from "./utils.ts";

// Default tags taken from s3proxy/src/test/resources/run-s3-tests.sh
const DEFAULT_TAGS = [
  "not fails_on_s3proxy",
  "and not appendobject",
  "and not bucket_policy",
  "and not checksum",
  "and not copy",
  "and not cors",
  "and not encryption",
  "and not fails_strict_rfc2616",
  "and not iam_tenant",
  "and not lifecycle",
  "and not object_lock",
  "and not policy",
  "and not policy_status",
  "and not s3select",
  "and not s3website",
  "and not sse_s3",
  "and not tagging",
  "and not test_of_sts",
  "and not user_policy",
  "and not versioning",
  "and not webidentity_test",
].join(" ");

const config: GlobalConfig = {
  backends: {
    minio: {
      protocol: "s3",
      endpoint: "http://localhost:9000",
      region: "us-east-1",
      credentials: {
        accessKeyId: "minioadmin",
        secretAccessKey: "minioadmin",
      },
      buckets: "*",
    },
  },
};

const program = makeTestHarness(config).pipe(
  Effect.flatMap((h) => {
    const port = new URL(h.proxyUrl).port;

    // Parse filtering arguments
    const tags = $.env.S3TEST_TAGS ?? DEFAULT_TAGS;
    const pytestArgsEnv = $.env.S3TEST_PYTEST_ARGS ?? "";
    const pytestArgsFromEnv = pytestArgsEnv ? pytestArgsEnv.split(/\s+/) : [];
    const pytestArgsFromCli = $.argv;
    const pytestArgs = [...pytestArgsFromEnv, ...pytestArgsFromCli];

    return Effect.gen(function* () {
      yield* Effect.logInfo(`Starting Herald proxy on port ${port}`);

      const confContent = `[DEFAULT]
host = 127.0.0.1
port = ${port}
is_secure = no

[fixtures]
bucket prefix = herald-{random}-

[s3 main]
user_id = main
display_name = main
email = main@example.com
access_key = minioadmin
secret_key = minioadmin

[s3 alt]
user_id = alt
display_name = alt
email = alt@example.com
access_key = minioadmin
secret_key = minioadmin

[s3 tenant]
user_id = tenant
display_name = tenant
email = tenant@example.com
access_key = minioadmin
secret_key = minioadmin
tenant = testx

[iam]
email = iam@example.com
user_id = iam
access_key = minioadmin
secret_key = minioadmin
display_name = iam

[iam root]
access_key = minioadmin
secret_key = minioadmin
user_id = iam_root
email = iam_root@example.com

[iam alt root]
access_key = minioadmin
secret_key = minioadmin
user_id = iam_alt_root
email = iam_alt_root@example.com
`;

      const confPath = yield* Effect.promise(() =>
        Deno.makeTempFile({ suffix: ".conf" })
      );
      yield* Effect.promise(() => Deno.writeTextFile(confPath, confContent));

      const __dirname = path.dirname(path.fromFileUrl(import.meta.url));
      const s3TestsDir = path.resolve(__dirname, "../s3-tests");
      const logPath = path.join(s3TestsDir, "s3-tests.log");

      yield* Effect.logInfo(`s3-tests directory: ${s3TestsDir}`);
      yield* Effect.logInfo(`Log file: ${logPath}`);

      // Ensure we have a virtual environment
      const venvPath = path.join(s3TestsDir, ".venv");
      const venvExists = yield* Effect.tryPromise(() =>
        Deno.stat(venvPath).then(() => true).catch(() => false)
      );

      if (!venvExists) {
        yield* Effect.logInfo("Creating Python virtual environment...");
        yield* Effect.tryPromise(() =>
          $`uv venv --python 3.11`.cwd(s3TestsDir)
        );
      }

      yield* Effect.logInfo(
        `Running s3-tests against Herald on port ${port}...`,
      );
      yield* Effect.logInfo(`Tags: ${tags}`);
      yield* Effect.logInfo(`Additional pytest args: ${pytestArgs.join(" ")}`);

      // Run pytest with timeout
      const timeoutId = setTimeout(() => {}, 300000); // 5 minutes

      try {
        // Build command arguments
        const cmdArgs: string[] = ["run", "pytest", "-v", "--tb=long"];

        if (tags) {
          cmdArgs.push("-m", tags);
        }

        // Add user-provided pytest arguments
        cmdArgs.push(...pytestArgs);

        // Add test path if not already specified
        const hasTestPath = pytestArgs.some((arg) =>
          arg.includes("s3tests/") || arg.includes("test_")
        );
        if (!hasTestPath) {
          cmdArgs.push("s3tests/functional/test_s3.py");
        }

        const result = yield* Effect.tryPromise({
          try: async () => {
            const proc = $`uv ${cmdArgs}`
              .cwd(s3TestsDir)
              .env({
                S3TEST_CONF: confPath,
                UV_PYTHON: "3.11",
              })
              .noThrow()
              .stdout("piped")
              .stderr("piped");
            return await proc;
          },
          catch: (e) => new Error(`Failed to run pytest: ${e}`),
        });

        // Write output to log file
        const stdoutBytes = yield* Effect.sync(() => {
          const stdout = result.stdout as unknown;
          if (stdout instanceof Uint8Array) {
            return stdout;
          }
          return new TextEncoder().encode(String(stdout));
        });
        const stderrBytes = yield* Effect.sync(() => {
          const stderr = result.stderr as unknown;
          if (stderr instanceof Uint8Array) {
            return stderr;
          }
          return new TextEncoder().encode(String(stderr));
        });
        const combined = new Uint8Array(
          stdoutBytes.length + stderrBytes.length,
        );
        combined.set(stdoutBytes);
        combined.set(stderrBytes, stdoutBytes.length);
        yield* Effect.tryPromise(() => Deno.writeFile(logPath, combined));

        if (result.code !== 0) {
          yield* Effect.logError(
            `s3-tests finished with exit code ${result.code}`,
          );

          // Show last 20 lines of log
          const tailResult = yield* Effect.tryPromise({
            try: async () => {
              const proc = $`tail -n 20 ${logPath}`.stdout("piped");
              return await proc;
            },
            catch: (e) => new Error(`Failed to tail log file: ${e}`),
          });
          yield* Effect.logError("Last 20 lines of log:");
          const tailOutput = yield* Effect.sync(() => {
            const stdout = tailResult.stdout as unknown;
            if (stdout instanceof Uint8Array) {
              return new TextDecoder().decode(stdout);
            }
            return String(stdout);
          });
          yield* Effect.logError(tailOutput);

          yield* Effect.fail(
            new Error(`s3-tests failed with exit code ${result.code}`),
          );
        } else {
          yield* Effect.logInfo("s3-tests passed!");
        }
      } finally {
        clearTimeout(timeoutId);
        yield* Effect.tryPromise(() => Deno.remove(confPath).catch(() => {}));
      }
    });
  }),
  Effect.scoped,
  Effect.provide(LoggingLive),
);

if (import.meta.main) {
  Effect.runPromiseExit(program).then((exitCode) => {
    if (exitCode._tag === "Failure") {
      Deno.exit(1);
    }
  }).catch((e) => {
    console.error(`Error: ${e}`);
    Deno.exit(1);
  });
}
