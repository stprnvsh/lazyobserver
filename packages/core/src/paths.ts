/**
 * Filesystem layout for lazyobserver.
 *
 * Everything lives under a single user-level home (default `~/.lazyobserver`),
 * intentionally independent of any workspace/repo so daily memory and the
 * event store span all of them. `LAZYOBSERVER_HOME` overrides the root — used
 * by tests (tmp dirs) and future multi-instance setups.
 */
import os from "node:os";
import path from "node:path";

export function lazyHome(): string {
  const override = process.env.LAZYOBSERVER_HOME;
  if (override && override.trim() !== "") return path.resolve(override);
  return path.join(os.homedir(), ".lazyobserver");
}

export const paths = {
  home: (): string => lazyHome(),
  configFile: (): string => path.join(lazyHome(), "config.json"),
  db: (): string => path.join(lazyHome(), "db"),
  spool: (): string => path.join(lazyHome(), "spool"),
  exports: (): string => path.join(lazyHome(), "exports"),
  logs: (): string => path.join(lazyHome(), "logs"),
  models: (): string => path.join(lazyHome(), "models"),
};

/** All directories `init` must create. */
export function allDirs(): string[] {
  return [
    paths.home(),
    paths.db(),
    paths.spool(),
    paths.exports(),
    paths.logs(),
    paths.models(),
  ];
}
