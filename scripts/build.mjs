import { build, context } from "esbuild";
import { rm, copyFile, mkdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");

await rm("dist", { recursive: true, force: true });

const common = {
  bundle: true,
  platform: "neutral",
  format: "esm",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
};

const entries = [
  {
    entryPoints: ["src/cli/index.ts"],
    outfile: "dist/cli.js",
    platform: "node",
    banner: { js: "#!/usr/bin/env node" },
    external: ["commander", "prompts", "postal-mime"],
  },
  {
    entryPoints: ["src/sdk/index.ts"],
    outfile: "dist/sdk.js",
    platform: "node",
    external: ["node:*"],
  },
  {
    entryPoints: ["src/sdk/playwright.ts"],
    outfile: "dist/playwright.js",
    platform: "node",
    external: ["@playwright/test", "node:*"],
  },
  {
    entryPoints: ["src/worker/index.ts"],
    outfile: "dist/worker.js",
    platform: "browser",
    conditions: ["worker", "browser"],
    external: [],
  },
];

if (watch) {
  const ctxs = await Promise.all(
    entries.map((e) => context({ ...common, ...e })),
  );
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  await Promise.all(entries.map((e) => build({ ...common, ...e })));
  await mkdir("dist", { recursive: true });
  await copyFile("src/worker/schema.sql", "dist/schema.sql");
  await copyFile("src/worker/migrations.sql", "dist/migrations.sql");
  await import("node:child_process").then(({ execSync }) => {
    execSync("tsc -p tsconfig.build.json", { stdio: "inherit" });
  });
  await import("node:fs/promises").then(({ chmod }) =>
    chmod("dist/cli.js", 0o755),
  );
}
