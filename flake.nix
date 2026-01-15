{
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };
  outputs = { flake-parts, ... } @ inputs: flake-parts.lib.mkFlake { inherit inputs; } {
    imports = [
      # ./module.nix
    ];

    perSystem = { config, self', inputs', pkgs, system, ... }: {
      # Allows definition of system-specific attributes
      # without needing to declare the system explicitly!
      #
      # Quick rundown of the provided arguments:
      # - config is a reference to the full configuration, lazily evaluated
      # - self' is the outputs as provided here, without system. (self'.packages.default)
      # - inputs' is the input without needing to specify system (inputs'.foo.packages.bar)
      # - pkgs is an instance of nixpkgs for your specific system
      # - system is the system this configuration is for

      devShells.default = pkgs.mkShell {
        buildInputs = with pkgs; [
          # inputs'.hk.packages.hk
          # corepack
          # nodejs_24
          # biome
          deno
          uv
          prek

          # For systems that do not ship with Python by default (required by `node-gyp`)
          # python3

          # infisical
          #
          # opentofu
          # terragrunt
          # awscli2
        ];
        shellHook = ''
          export PATH=$PATH:$PWD/x/
          exec $(getent passwd $USER | cut -d: -f7)
        '';
      };

      packages = let
        # Import tools/default.nix - flake-parts will handle source filtering
        webTools = import ./tools/default.nix { inherit pkgs; };
      in {
        # Web app build output
        webApp = webTools.webApp;

        # Docker/OCI image for the web app
        webImage = webTools.webImage;
      };
    };

    flake = {
      # The usual flake attributes can be defined here, including
      # system-agnostic and/or arbitrary outputs.
    };


    # Declared systems that your flake supports. These will be enumerated in perSystem
    systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
  };
}
