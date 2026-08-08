import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "tsup";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(fixtureDir, "..", "..");
const intendedFiles = [
  "README.md",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/index.js.map",
  "dist/react-native.d.ts",
  "dist/react-native.js",
  "dist/react-native.js.map",
  "package.json",
].sort();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(
      `${command} ${args.join(" ")} exited with status ${result.status}`,
    );
  }

  return result.stdout.trim();
}

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const files = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(join(directory, entry.name), relativePath)));
    } else {
      files.push(relativePath);
    }
  }
  return files;
}

const tempRoot = await mkdtemp(join(tmpdir(), "bip158-package-smoke-"));
try {
  const packDir = join(tempRoot, "pack");
  await mkdir(packDir);

  const packJson = run(
    "npm",
    [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      packDir,
    ],
    { cwd: packageRoot },
  );
  const [packResult] = JSON.parse(packJson);
  assert.ok(packResult, "npm pack returned no package result");

  const packedFiles = packResult.files.map(({ path }) => path).sort();
  assert.deepEqual(packedFiles, intendedFiles);

  const tarballPath = resolve(packDir, packResult.filename);
  assert.equal((await lstat(tarballPath)).isFile(), true);
  console.log(`npm pack: ${packedFiles.join(", ")}`);

  const consumerDir = join(tempRoot, "consumer");
  await mkdir(consumerDir);
  await writeFile(
    join(consumerDir, "package.json"),
    `${JSON.stringify(
      {
        name: "bip158-package-smoke-consumer",
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
  assert.deepEqual(await readdir(consumerDir), ["package.json"]);

  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--no-save",
      tarballPath,
    ],
    {
      cwd: consumerDir,
      env: { npm_config_ignore_scripts: "true" },
    },
  );

  const installedPackageRoot = join(
    consumerDir,
    "node_modules",
    "bip158",
  );
  const installedPackageStat = await lstat(installedPackageRoot);
  assert.equal(installedPackageStat.isDirectory(), true);
  assert.equal(installedPackageStat.isSymbolicLink(), false);
  assert.notEqual(
    await realpath(installedPackageRoot),
    await realpath(packageRoot),
  );
  assert.deepEqual((await listFiles(installedPackageRoot)).sort(), intendedFiles);
  console.log("npm install: isolated tarball consumer installed without scripts");

  const runtimeSmoke = join(consumerDir, "runtime-smoke.mjs");
  await copyFile(join(fixtureDir, "runtime-smoke.mjs"), runtimeSmoke);
  console.log(run(process.execPath, [runtimeSmoke], { cwd: consumerDir }));
  console.log(run("bun", [runtimeSmoke], { cwd: consumerDir }));

  const typesSmoke = join(consumerDir, "types-smoke.ts");
  await copyFile(join(fixtureDir, "types-smoke.ts.txt"), typesSmoke);
  const tscPath = join(
    packageRoot,
    "node_modules",
    "typescript",
    "bin",
    "tsc",
  );
  run(
    process.execPath,
    [
      tscPath,
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      typesSmoke,
    ],
    { cwd: consumerDir },
  );
  console.log("TypeScript: installed declarations typechecked");

  const browserSmoke = join(consumerDir, "browser-smoke.mjs");
  await copyFile(join(fixtureDir, "browser-smoke.mjs"), browserSmoke);
  const browserOutDir = join(tempRoot, "browser");
  await build({
    bundle: true,
    clean: true,
    config: false,
    dts: false,
    entry: { "browser-smoke": browserSmoke },
    format: "esm",
    noExternal: [/.*/],
    outDir: browserOutDir,
    platform: "browser",
    silent: true,
    sourcemap: false,
    splitting: false,
    target: "es2022",
  });

  const outputNames = await readdir(browserOutDir);
  assert.deepEqual(outputNames, ["browser-smoke.js"]);

  const browserBundle = await readFile(
    join(browserOutDir, "browser-smoke.js"),
    "utf8",
  );
  assert.doesNotMatch(browserBundle, /\bnode:/);
  assert.doesNotMatch(
    browserBundle,
    /^\s*(?:(?:import|export)\s+[^'"\n]*?\s+from\s+|import\s*)["'][^"']+["']/m,
  );
  assert.doesNotMatch(browserBundle, /\bimport\s*\(\s*["'][^"']+["']/);

  const browserModule = await import(
    `data:text/javascript;base64,${Buffer.from(browserBundle).toString("base64")}`
  );
  assert.equal(browserModule.browserSmokePassed, true);
  console.log(
    "Browser: installed package bundled without Node built-ins and ran",
  );

  const reactNativeEntry = join(
    installedPackageRoot,
    "dist",
    "react-native.js",
  );
  const reactNativeSource = await readFile(reactNativeEntry, "utf8");
  assert.doesNotMatch(reactNativeSource, /\bnode:/);
  assert.doesNotMatch(reactNativeSource, /from\s+["']@noble\//);
  assert.doesNotMatch(reactNativeSource, /\bBuffer\b/);
  assert.match(
    await readFile(join(packageRoot, "dist", "index.js"), "utf8"),
    /from\s+["']@noble\/hashes\//,
  );

  const reactNativeModule = await import(reactNativeEntry);
  const blockHashDisplay = reactNativeModule.hexToBytes(
    "000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943",
  );
  const coinbaseScript = reactNativeModule.hexToBytes(
    "4104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac",
  );
  const filter = reactNativeModule.buildBasicFilter({
    blockHashDisplay,
    elements: [coinbaseScript],
  });
  assert.equal(reactNativeModule.bytesToHex(filter), "019dfca8");
  assert.deepEqual(
    reactNativeModule.matchAnyBasicFilters(
      [filter],
      [blockHashDisplay],
      [coinbaseScript],
    ),
    [true],
  );
  console.log(
    "React Native: bundled entry has no Node/@noble imports and matches genesis",
  );
} finally {
  await rm(tempRoot, { force: true, recursive: true });
}
