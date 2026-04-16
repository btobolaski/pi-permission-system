{
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    utils,
    ...
  }: let
    out = system: let
      pkgs = import nixpkgs {
        inherit system;
      };

      lib = pkgs.lib;
      commonPackages = [
        pkgs.nodejs_22
        pkgs.pnpm
      ];
    in {
      devShells = {
        default = pkgs.mkShell {
          buildInputs = commonPackages;
        };
      };
    };
  in
    with utils.lib; eachSystem defaultSystems out;
}
