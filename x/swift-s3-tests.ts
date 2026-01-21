#!/usr/bin/env -S deno run --allow-all

/**
 * Herald Swift Compatibility Test Runner
 *
 * This script runs the Ceph s3-tests suite against a Herald proxy instance
 * configured with an OpenStack Swift backend.
 */

import { Config, Effect, Layer, Logger, LogLevel, Stream } from "effect";
import { makeTestHarness } from "../tests/utils.ts";
import type { GlobalConfig } from "../src/Domain/Config.ts";
import * as path from "@std/path";
import { $ } from "./utils.ts";
import * as colors from "@std/fmt/colors";

const program = Effect.gen(function* () {
  const __dirname = path.dirname(path.fromFileUrl(import.meta.url));
  const s3TestsDir = path.resolve(__dirname, "../s3-tests");
  const proxyLogPath = path.join(s3TestsDir, "herald-proxy-swift.log");

  // Read Swift config from environment
  const authUrl = yield* Config.string("HERALD_SWIFTTEST_AUTH_URL").pipe(
    Config.orElse(() => Config.string("HEARLD_SWIFTTEST_AUTH_URL")),
    Config.orElse(() => Config.string("OS_AUTH_URL")),
    Config.withDefault("https://api.pub1.infomaniak.cloud/identity/v3"),
  );
  const region = yield* Config.string("HERALD_SWIFTTEST_OS_REGION_NAME").pipe(
    Config.orElse(() => Config.string("HEARLD_SWIFTTEST_OS_REGION_NAME")),
    Config.orElse(() => Config.string("TF_VAR_OS_REGION_NAME")),
    Config.orElse(() => Config.string("OS_REGION_NAME")),
    Config.withDefault("dc3-a"),
  );
  const username = yield* Config.string("HERALD_SWIFTTEST_OS_USERNAME").pipe(
    Config.orElse(() => Config.string("TF_VAR_OS_USERNAME")),
    Config.orElse(() => Config.string("OS_USERNAME")),
    Config.withDefault(""),
  );
  const password = yield* Config.string("HERALD_SWIFTTEST_OS_PASSWORD").pipe(
    Config.orElse(() => Config.string("TF_VAR_OS_PASSWORD")),
    Config.orElse(() => Config.string("OS_PASSWORD")),
    Config.withDefault(""),
  );
  const projectName = yield* Config.string("HERALD_SWIFTTEST_OS_PROJECT_NAME")
    .pipe(
      Config.orElse(() => Config.string("TF_VAR_OS_PROJECT_NAME")),
      Config.orElse(() => Config.string("OS_PROJECT_NAME")),
      Config.withDefault(""),
    );

  if (!authUrl || !username || !password || !projectName) {
    return yield* Effect.fail(
      new Error(
        "Swift environment variables (HERALD_SWIFTTEST_...) are missing. Run with infisical.",
      ),
    );
  }

  const swiftConfig: GlobalConfig = {
    backends: {
      swift: {
        protocol: "swift",
        auth_url: authUrl,
        region: region || undefined,
        credentials: {
          username,
          password,
          project_name: projectName,
          user_domain_name: "Default",
          project_domain_name: "Default",
        },
        buckets: "*",
      },
    },
  };

  // Create a file logger for the proxy
  const proxyLogFile = yield* Effect.tryPromise(() =>
    Deno.open(proxyLogPath, { write: true, create: true, truncate: true })
  );

  yield* Effect.addFinalizer(() =>
    Effect.tryPromise({
      try: () => Promise.resolve(proxyLogFile.close()),
      catch: (e) => new Error(`Failed to close proxy log file: ${e}`),
    }).pipe(Effect.orDie)
  );

  // Provide the test harness
  const h = yield* makeTestHarness(swiftConfig);
  const port = new URL(h.proxyUrl).port;

  console.log(`Starting Herald (Swift backend) on port ${colors.cyan(port)}`);
  console.log(`Proxy logs: ${colors.gray(proxyLogPath)}`);

  const confContent = `[DEFAULT]
host = 127.0.0.1
port = ${port}
is_secure = no

[fixtures]
bucket prefix = herald-swift-{random}-

[s3 main]
user_id = main
display_name = main
email = main@example.com
access_key = dummy
secret_key = dummy

[s3 alt]
user_id = alt
display_name = alt
email = alt@example.com
access_key = dummy
secret_key = dummy

[s3 tenant]
user_id = tenant
display_name = tenant
email = tenant@example.com
access_key = dummy
secret_key = dummy
tenant = dummy

[iam]
email = s3@example.com
user_id = 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
access_key = dummy
secret_key = dummy
display_name = youruseridhere

[iam root]
access_key = dummyroot
secret_key = dummyroot
user_id = RGW11111111111111111
email = account1@ceph.com

[iam alt root]
access_key = dummyaltroot
secret_key = dummyaltroot
user_id = RGW22222222222222222
email = account2@ceph.com
`;

  const confPath = yield* Effect.promise(() =>
    Deno.makeTempFile({ suffix: ".conf" })
  );
  yield* Effect.promise(() => Deno.writeTextFile(confPath, confContent));
  yield* Effect.addFinalizer(() =>
    Effect.promise(() =>
      Deno.remove(confPath).catch((e) => {
        console.error(`Failed to remove conf file ${confPath}: ${e}`);
      })
    )
  );

  const logPath = path.join(s3TestsDir, "s3-tests-swift.log");
  const junitXmlPath = path.join(s3TestsDir, "junit-swift.xml");

  const rawArgs = $.argv;
  const noAbort = rawArgs.includes("--no-abort");
  const pytestArgsFromCli = rawArgs.filter((arg) => arg !== "--no-abort");

  const cmdArgs: string[] = [
    "run",
    "pytest",
    "-v",
    "--tb=short",
    `--junit-xml=${junitXmlPath}`,
    ...pytestArgsFromCli,
  ];

  // If no specific test path, default to test_s3.py
  if (
    !pytestArgsFromCli.some((arg) =>
      arg.includes("s3tests/") || arg.endsWith(".py")
    )
  ) {
    cmdArgs.push("s3tests/functional/test_s3.py");
  }

  console.log(`Running s3-tests against Herald (Swift)...`);

  const logFile = yield* Effect.tryPromise(() =>
    Deno.open(logPath, { write: true, create: true, truncate: true })
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => Promise.resolve(logFile.close()))
  );

  const result = yield* Effect.tryPromise({
    try: async () => {
      const child = $`uv ${cmdArgs}`
        .cwd(s3TestsDir)
        .env({
          S3TEST_CONF: confPath,
          UV_PYTHON: "3.11",
          PYTHONUNBUFFERED: "1",
        })
        .noThrow()
        .stdout("piped")
        .stderr("piped")
        .spawn();

      const decoder = new TextDecoder();
      async function streamToLog(stream: ReadableStream<Uint8Array>) {
        const reader = stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await logFile.write(value);
          Deno.stdout.writeSync(value); // Echo to console for now
        }
      }

      const [procResult] = await Promise.all([
        child,
        streamToLog(child.stdout()),
        streamToLog(child.stderr()),
      ]);

      return procResult;
    },
    catch: (e) => new Error(`Failed to run pytest: ${e}`),
  });

  if (result.code !== 0) {
    yield* Effect.fail(new Error(`s3-tests failed with code ${result.code}`));
  }

  console.log(colors.green(`\n✓ s3-tests completed successfully.`));
}).pipe(
  Effect.scoped,
  Effect.provide(Logger.minimumLogLevel(LogLevel.Debug)),
);

if (import.meta.main) {
  Effect.runPromiseExit(program).then((exit) => {
    if (exit._tag === "Failure") {
      console.error(colors.red(`Error: ${exit.cause}`));
      Deno.exit(1);
    }
  });
}
