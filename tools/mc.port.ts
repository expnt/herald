// @ts-nocheck: Deno file
import {
  $,
  ALL_ARCH,
  defaultLatestStable,
  DownloadArgs,
  downloadFile,
  dwnUrlOut,
  type InstallArgs,
  InstallConfigFat,
  type InstallConfigSimple,
  type ListAllArgs,
  osXarch,
  PortBase,
} from "@ghjk/deno_ports";

const manifest = {
  ty: "denoWorker@v1" as const,
  name: "mc_minio",
  version: "0.1.0",
  moduleSpecifier: import.meta.url,
  // darwin releases only avail on brew
  platforms: [...osXarch(["linux"], [...ALL_ARCH]), "windows-x86_64"],
};

export default function conf(config: InstallConfigSimple) {
  const out: InstallConfigFat = {
    ...config,
    port: manifest,
  };
  return out;
}

export class Port extends PortBase {
  listAll(args: ListAllArgs) {
    return [args.config.version ?? "0.1"];
  }

  latestStable(args: ListAllArgs): Promise<string> {
    return defaultLatestStable(this, args);
  }

  downloadUrls(args: DownloadArgs) {
    const { platform } = args;
    const os = platform.os;
    let arch;
    switch (platform.os) {
      case "windows": {
        switch (platform.arch) {
          case "x86_64":
            arch = "amd64";
            break;
          default:
            throw new Error(`unsupported: ${platform}`);
        }
        break;
      }
      case "linux": {
        switch (platform.arch) {
          case "x86_64":
            arch = "amd64";
            break;
          case "aarch64":
            arch = "arm64";
            break;
          default:
            throw new Error(`unsupported: ${platform}`);
        }
        break;
      }
      case "darwin": {
        // ou "macos"
        switch (platform.arch) {
          case "x86_64":
            arch = "amd64"; // ou "arm64" selon ton besoin
            break;
          case "arm64":
            arch = "arm64";
            break;
          default:
            throw new Error(`unsupported: ${JSON.stringify(platform)}`);
        }
        break;
      }
      default:
        throw new Error(`unsupported: ${platform}`);
    }

    return [`https://dl.min.io/client/mc/release/${os}-${arch}/mc`].map(
      dwnUrlOut,
    );
  }
  async download(args: DownloadArgs) {
    const urls = this.downloadUrls(args);
    await Promise.all(
      urls.map((obj) => downloadFile({ ...args, ...obj, mode: 0o700 })),
    );
  }

  async install(args: InstallArgs) {
    const installPath = $.path(args.installPath);
    if (await installPath.exists()) {
      await installPath.remove({ recursive: true });
    }

    await $.path(args.downloadPath).copy(installPath.join("bin"));
  }
}
