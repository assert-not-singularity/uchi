import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SETTINGS_PATH = path.join(
  os.homedir(),
  ".local",
  "state",
  "omarchy",
  "settings",
  "uchi.json"
);

export class ConfigError extends Error {}

// Reads {address, token}, written by `uchi setup` and read only here. Opens by
// descriptor (O_NOFOLLOW, then fstat) rather than by path so a symlink or a
// mode change after the fact can't slip a wider-than-0600 file past the check.
export function readSettings(settingsPath = SETTINGS_PATH) {
  let fd;
  try {
    fd = fs.openSync(settingsPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    throw new ConfigError(`could not open ${settingsPath} (${err.message}) — run \`uchi setup\`.`);
  }

  try {
    const stat = fs.fstatSync(fd);
    if ((stat.mode & 0o077) !== 0) {
      const mode = (stat.mode & 0o777).toString(8);
      throw new ConfigError(
        `${settingsPath} is readable by group/other (mode ${mode}) — re-run \`uchi setup\` to rewrite it at 0600.`
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(fd, "utf8"));
    } catch {
      throw new ConfigError(`${settingsPath} is not valid JSON — re-run \`uchi setup\`.`);
    }

    const { address, token } = parsed ?? {};
    if (typeof address !== "string" || address.length === 0 ||
        typeof token !== "string" || token.length === 0) {
      throw new ConfigError(
        `${settingsPath} is missing "address" and/or "token" — re-run \`uchi setup\`.`
      );
    }

    return { address, token };
  } finally {
    fs.closeSync(fd);
  }
}
