/**
 * `lzo brief` — print the SessionStart context brief.
 *
 * --hook mode is called by the SessionStart hook: reads the hook JSON from
 * stdin (for cwd), prints the brief to stdout (Claude Code injects it as
 * session context) and NEVER fails — worst case it prints nothing.
 */
import { buildSessionStartBrief, Store } from "@lazyobserver/core";

export async function briefCommand(opts: { hook: boolean }): Promise<void> {
  try {
    let cwd = process.cwd();
    if (opts.hook) {
      const stdin = await new Promise<string>((resolve) => {
        let data = "";
        const timer = setTimeout(() => resolve(data), 1500);
        process.stdin.on("data", (c) => (data += c));
        process.stdin.on("end", () => {
          clearTimeout(timer);
          resolve(data);
        });
        process.stdin.on("error", () => resolve(data));
      });
      try {
        const payload = JSON.parse(stdin) as { cwd?: string };
        if (payload.cwd) cwd = payload.cwd;
      } catch {
        /* no/invalid stdin — fall back to process cwd */
      }
    }
    const store = await Store.open();
    const brief = await buildSessionStartBrief(store, cwd);
    if (brief) console.log(brief);
  } catch {
    // a broken brief must never break a session start
  }
  if (opts.hook) process.exit(0);
}
