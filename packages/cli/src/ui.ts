import pc from "picocolors";

export const ok = (msg: string): void => console.log(`${pc.green("✓")} ${msg}`);
export const warn = (msg: string): void =>
  console.log(`${pc.yellow("!")} ${msg}`);
export const fail = (msg: string): void => console.log(`${pc.red("✗")} ${msg}`);
export const info = (msg: string): void => console.log(`${pc.dim("·")} ${msg}`);
export const heading = (msg: string): void =>
  console.log(`\n${pc.bold(msg)}`);
