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
        Addresses to listen on. Every address serves the same routes, and each request sees
        its real peer. An address after the first that is not on the machine yet, such as a
        container's veth end, is retried until it appears.
      '';
    };

    dataPath = lib.mkOption {
      type = lib.types.str;
      default = "%h/.ungate/data.db";
      example = "%h/.ungate/headless.db";
      description = ''
        SQLite database the service opens (its `DB_PATH`). The default is the database the
        Cursor extension uses, so an extension that adopts the service on its port sees the
        same accounts and usage. Set another path to keep the service's state apart.
      '';
    };

    stopTimeoutSec = lib.mkOption {
      type = lib.types.ints.positive;
      default = 60;
      description = ''
        How long systemd waits after SIGTERM before killing the service. On SIGTERM the API
        stops accepting connections and lets active streams finish within its own drain
        bound, which stays below this.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.user.services.ungate = {
      description = "ungate API";
      wantedBy = [ "default.target" ];
      environment = {
        PORT = toString cfg.port;
        HOST = lib.concatStringsSep "," cfg.hosts;
        DB_PATH = cfg.dataPath;
      };
      # Never give up restarting: a crash loop backs off instead of failing the unit for good.
      startLimitIntervalSec = 0;
      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        Restart = "always";
        RestartSec = 2;
        RestartSteps = 5;
        RestartMaxDelaySec = 60;
        TimeoutStopSec = cfg.stopTimeoutSec;
      };
    };
  };
}
