import { file, ports, stdDeps } from "./tools/deps.ts";

// constants
const DENO_VERSION = "2.2.3";
const PYTHON_VERSION = "3.9.19";

// installs
const installs = {
  deno: ports.deno_ghrel({
    version: DENO_VERSION,
  }),
  python: ports.cpy_bs({ version: PYTHON_VERSION, releaseTag: "20240814" }),
}

const ghjk = file({
    tasks: {

      "dev-compose": {
    desc: "Wrapper around docker compose to manage runtime dependencies",
    async fn($) {
      const dcs = await Array.fromAsync(
        $.workingDir.join("tools/compose").expandGlob("compose.*.yml", {
          includeDirs: false,
          globstar: true,
        }),
      );
      const files = Object.fromEntries(
        dcs.map((e) => [e.path.basename().split(".")[1], e.path]),
      );

      const on = new Set<string>();
      if ($.argv.length === 1 && $.argv[0] === "all") {
        Object.values(files).forEach((e) => on.add(e.toString()));
      } else {
        for (const arg of $.argv) {
          if (!files[arg]) {
            console.log(
              `Unknown env "${arg}", available: ${
                Object.keys(files).join(
                  ", ",
                )
              } or "all".`,
            );
            Deno.exit(1);
          }
          on.add(files[arg].toString());
        }
      }

      if (on.size > 0) {
        await $.raw`docker compose ${
          [...on].flatMap((file) => [
            "-f",
            file,
          ])
        } up -d --remove-orphans`;
      } else {
        await $.raw`docker compose ${
          Object.values(files).flatMap((file) => [
            "-f",
            file,
          ])
        } down --remove-orphans --volumes`;
      }
    },
  },

  "dev-proxy": {
    desc: "Run the proxy inside a docker container",
    async fn($) {
      const arg = $.argv[0];
      if (arg !== 'up' && arg !== 'down') {
        console.log(
          `Unsupported subcommand "${arg}", available: 'up' and 'down'`,
        );
        Deno.exit(1);
      }

      if (arg === "up") {
        await $.raw`docker compose up -d --remove-orphans`;
        console.log("It might take some time for the proxy to download dependencies based on your internet speed")
      } else {
        await $.raw`docker compose down --remove-orphans --volumes`;
      }
    }
  },


  "build-proxy": {
    desc: "Rebuild the proxy docker image",
    async fn($) {
      await $.raw`docker-compose build --no-cache proxy`;
      await $.raw`docker-compose up -d --force-recreate`;
    }
  },

  "install-sys-deps": {
    desc: "Install system dependencies",
    async fn($) {
      // deno
      await $.raw`curl -fsSL https://deno.land/install.sh | sh`;
      // pre-commit
      await $.raw`pip install pre-commit`;
      await $.raw`pre-commit install`;
    }
  },

  "setup-auth": {
    desc: "Setup auth",
    async fn($) {
      const token = await $.raw`kubectl exec datacycle-backend-generic -n stg-datacycle -- cat /var/run/secrets/kubernetes.io/serviceaccount/token`.stdout("piped").stderr("piped");
      const tokenPath = "serviceaccount/token";
      Deno.env.set("SERVICE_ACCOUNT_TOKEN_PATH", tokenPath);
      await Deno.mkdir("serviceaccount", { recursive: true });
      await Deno.writeTextFile(tokenPath, token.stdout);

      const cert = await $.raw`kubectl exec datacycle-backend-generic -n stg-datacycle -- cat /var/run/secrets/kubernetes.io/serviceaccount/ca.crt`.stdout("piped").stderr("piped");
      const certPath = "serviceaccount/ca.crt";
      Deno.env.set("CERT_PATH", certPath);
      await Deno.writeTextFile(certPath, cert.stdout);
    }
  }

    },
  });

// ghjk.install(installs.deno, installs.python, ports.pipi({ packageName: "pre-commit", version: "3.7.1" })[0],);

export const sophon = ghjk.sophon;
const { env, task } = ghjk;

env("main")
.install(
  installs.deno,
  ports.pipi({ packageName: "pre-commit", version: "3.7.1" })[0],
).allowedBuildDeps(
  ...stdDeps(),
    installs.python,
)
