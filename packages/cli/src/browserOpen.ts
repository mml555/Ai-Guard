import { spawn } from "node:child_process";

export const DEFAULT_CONSOLE_PORT = 5174;

/** Console URL with ?url=&token= so the operator UI can auto-sign-in after setup. */
export function buildAutoconnectConsoleUrl(
  apiUrl: string,
  apiKey: string,
  consolePort = DEFAULT_CONSOLE_PORT,
): string {
  const params = new URLSearchParams({ url: apiUrl, token: apiKey });
  return `http://localhost:${consolePort}/login?${params.toString()}`;
}

/** The platform command to open a URL in the default browser (pure/testable). */
export function browserOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  // `start` needs an empty title arg so a URL with spaces/& isn't read as the title.
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
  return { cmd: "xdg-open", args: [url] };
}

/**
 * Best-effort: open the setup console in the operator's browser after `setup`.
 * Skipped for non-interactive/CI/`--json` runs so headless pipelines never spawn
 * a browser; the printed link is always the fallback. Returns whether it tried.
 */
export function maybeOpenBrowser(url: string): boolean {
  if (process.env.CI || process.env.MODELGOV_NO_OPEN || !process.stdout.isTTY) return false;
  try {
    const { cmd, args } = browserOpenCommand(process.platform, url);
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* opener missing (e.g. no xdg-open) — the printed link is the fallback */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
