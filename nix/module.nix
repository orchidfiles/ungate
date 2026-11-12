self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.ungate;
in
{
  options.services.ungate = {
    enable = lib.mkEnableOption "the ungate API as a systemd user service";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.ungate-api;
      defaultText = lib.literalExpression "ungate.packages.\${system}.ungate-api";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 47821;
      description = "Port the API listens on; the Cursor extension adopts a running API on it.";
    };

    hosts = lib.mkOption {
      type = lib.types.nonEmptyListOf lib.types.str;
      default = [ "127.0.0.1" ];
      example = [
        "127.0.0.1"
        "10.233.1.1"
      ];
      description = ''
        Addresses to listen on. Admin routes answer only direct loopback requests on any of
        them; other addresses reach the model routes with a client key.
      '';
    };

    dataPath = lib.mkOption {
      type = lib.types.str;
      default = "%h/.ungate/data.db";
      description = "SQLite database; the default is the one the Cursor extension uses.";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.user.services.ungate = {
      description = "ungate API";
      wantedBy = [ "default.target" ];
      after = [ "network-online.target" ];
      environment = {
        PORT = toString cfg.port;
        HOST = lib.concatStringsSep "," cfg.hosts;
        DB_PATH = cfg.dataPath;
      };
      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        Restart = "on-failure";
        RestartSec = 2;
      };
    };
  };
}
