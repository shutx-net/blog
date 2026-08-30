{
  description = "Development shell for shutx-net/blog";

  inputs = {
    # Channel tarball rather than `github:NixOS/nixpkgs/nixos-26.05`: some networks block
    # api.github.com, and that is the only host nix's `github:` fetcher will talk to.
    # channels.nixos.org redirects to an immutable releases.nixos.org snapshot, so the lock
    # file still pins one exact nixpkgs revision.
    nixpkgs.url = "https://channels.nixos.org/nixos-26.05/nixexprs.tar.xz";
  };

  outputs =
    { nixpkgs, ... }:
    let
      inherit (nixpkgs) lib;

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          name = "blog";

          packages = [
            # Pinned explicitly rather than via pkgs.nodejs: that alias moves between
            # nixpkgs releases. 24 is what matters here -- Astro 7 needs >= 22.12.0, and
            # Lambda's nodejs24.x runtime is what api/ deploys onto, so local and deployed
            # majors match.
            pkgs.nodejs_24

            # aws s3 sync, secretsmanager, sso login.
            pkgs.awscli2

            # PR and workflow operations against shutx-net/blog.
            pkgs.gh

            # Reading aws-cli and cdk JSON output.
            pkgs.jq
          ];

          # No aws-cdk package on purpose. The CDK CLI has to move in lockstep with
          # aws-cdk-lib, and only package.json can express that, so it lives in
          # infra/devDependencies and is invoked as `npx -w infra cdk`. A second cdk on
          # PATH could only ever disagree with the one the project pins.

          shellHook = ''
            echo "blog dev shell"
            echo "  node : $(node --version)  (Lambda runtime: nodejs24.x)"
            echo "  npm  : $(npm --version)"
            echo "  aws  : $(aws --version 2>&1 | cut -d' ' -f1)"
            echo "  cdk  : npx -w infra cdk   (pinned in infra/package.json)"
            echo "  docs : DEVELOPERS.md"
          '';
        };
      });

      # nixfmt-tree rather than bare nixfmt: `nix fmt` with no arguments passes none on to
      # the formatter, and nixfmt then reads stdin instead of the tree.
      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);
    };
}
