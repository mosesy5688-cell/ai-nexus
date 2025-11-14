import yargs from "yargs-parser";
import { apply as applyPolyfill } from "../core/polyfill.js";
function resolveCommand(flags) {
  const cmd = flags._[2];
  if (flags.version) return "version";
  const supportedCommands = /* @__PURE__ */ new Set([
    "add",
    "sync",
    "telemetry",
    "preferences",
    "dev",
    "build",
    "preview",
    "check",
    "create-key",
    "docs",
    "db",
    "info",
    "login",
    "logout",
    "link",
    "init"
  ]);
  if (supportedCommands.has(cmd)) {
    return cmd;
  }
  return "help";
}
async function runCommand(cmd, flags) {
  applyPolyfill();
  const [
    { createLoggerFromFlags },
    { createPicocolorsTextStyler },
    { createBuildTimeAstroVersionProvider },
    { createLoggerHelpDisplay },
    { createCliCommandRunner }
  ] = await Promise.all([
    import("./flags.js"),
    import("./infra/picocolors-text-styler.js"),
    import("./infra/build-time-astro-version-provider.js"),
    import("./infra/logger-help-display.js"),
    import("./infra/cli-command-runner.js")
  ]);
  const logger = createLoggerFromFlags(flags);
  const textStyler = createPicocolorsTextStyler();
  const astroVersionProvider = createBuildTimeAstroVersionProvider();
  const helpDisplay = createLoggerHelpDisplay({
    logger,
    flags,
    textStyler,
    astroVersionProvider
  });
  const runner = createCliCommandRunner({ helpDisplay });
  switch (cmd) {
    /** Display --help flag */
    case "help": {
      const { DEFAULT_HELP_PAYLOAD } = await import("./help/index.js");
      helpDisplay.show(DEFAULT_HELP_PAYLOAD);
      return;
    }
    /** Display --version flag */
    case "version": {
      const { formatVersion } = await import("./utils/format-version.js");
      logger.info(
        "SKIP_FORMAT",
        formatVersion({ name: "astro", textStyler, astroVersionProvider })
      );
      return;
    }
    case "info": {
      const { printInfo } = await import("./info/index.js");
      await printInfo({ flags });
      return;
    }
    case "create-key": {
      const [{ createCryptoKeyGenerator }, { createKeyCommand }] = await Promise.all([
        import("./create-key/infra/crypto-key-generator.js"),
        import("./create-key/core/create-key.js")
      ]);
      const keyGenerator = createCryptoKeyGenerator();
      return await runner.run(createKeyCommand, { logger, keyGenerator });
    }
    case "docs": {
      const [
        { createTinyexecCommandExecutor },
        { createProcessOperatingSystemProvider },
        { createProcessCloudIdeProvider },
        { openDocsCommand }
      ] = await Promise.all([
        import("./infra/tinyexec-command-executor.js"),
        import("./infra/process-operating-system-provider.js"),
        import("./docs/infra/process-cloud-ide-provider.js"),
        import("./docs/core/open-docs.js")
      ]);
      const commandExecutor = createTinyexecCommandExecutor();
      const operatingSystemProvider = createProcessOperatingSystemProvider();
      const cloudIdeProvider = createProcessCloudIdeProvider();
      return await runner.run(openDocsCommand, {
        url: "https://docs.astro.build/",
        logger,
        commandExecutor,
        operatingSystemProvider,
        cloudIdeProvider
      });
    }
    case "telemetry": {
      const { update } = await import("./telemetry/index.js");
      const subcommand = flags._[3]?.toString();
      await update(subcommand, { flags });
      return;
    }
    case "sync": {
      const { sync } = await import("./sync/index.js");
      await sync({ flags });
      return;
    }
    case "preferences": {
      const { preferences } = await import("./preferences/index.js");
      const [subcommand, key, value] = flags._.slice(3).map((v) => v.toString());
      const exitCode = await preferences(subcommand, key, value, { flags });
      return process.exit(exitCode);
    }
  }
  if (flags.verbose) {
    const { enableVerboseLogging } = await import("../core/logger/node.js");
    enableVerboseLogging();
  }
  const { notify } = await import("./telemetry/index.js");
  await notify();
  switch (cmd) {
    case "add": {
      const { add } = await import("./add/index.js");
      const packages = flags._.slice(3);
      await add(packages, { flags });
      return;
    }
    case "db":
    case "login":
    case "logout":
    case "link":
    case "init": {
      const { db } = await import("./db/index.js");
      await db({ flags });
      return;
    }
    case "dev": {
      const { dev } = await import("./dev/index.js");
      const server = await dev({ flags });
      if (server) {
        return await new Promise(() => {
        });
      }
      return;
    }
    case "build": {
      const { build } = await import("./build/index.js");
      await build({ flags });
      return;
    }
    case "preview": {
      const { preview } = await import("./preview/index.js");
      const server = await preview({ flags });
      if (server) {
        return await server.closed();
      }
      return;
    }
    case "check": {
      const { check } = await import("./check/index.js");
      const checkServer = await check(flags);
      if (flags.watch) {
        return await new Promise(() => {
        });
      } else {
        return process.exit(typeof checkServer === "boolean" && checkServer ? 1 : 0);
      }
    }
  }
  throw new Error(`Error running ${cmd} -- no command found.`);
}
async function cli(argv) {
  const flags = yargs(argv, { boolean: ["global"], alias: { g: "global" } });
  const cmd = resolveCommand(flags);
  try {
    await runCommand(cmd, flags);
  } catch (err) {
    const { throwAndExit } = await import("./throw-and-exit.js");
    await throwAndExit(cmd, err);
  }
}
export {
  cli
};
