import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(fixtureDir, "..", "..");

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

async function intendedPackFiles() {
  const srcFiles = (await listFiles(join(packageRoot, "src"))).map(
    (path) => `src/${path}`,
  );
  return ["README.md", "package.json", ...srcFiles].sort();
}

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

const tempRoot = await mkdtemp(join(tmpdir(), "bip158-package-smoke-"));
try {
  const intendedFiles = await intendedPackFiles();
  const packDir = join(tempRoot, "pack");
  await mkdir(packDir);

  // Keep pack output to JSON only (npm may still print noise around the array).
  const packJson = run(
    "npm",
    [
      "pack",
      "--json",
      "--ignore-scripts",
      "--foreground-scripts=false",
      "--pack-destination",
      packDir,
    ],
    {
      cwd: packageRoot,
      env: {
        npm_config_ignore_scripts: "true",
        npm_config_foreground_scripts: "false",
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
    },
  );
  const jsonStart = packJson.indexOf("[");
  const jsonEnd = packJson.lastIndexOf("]");
  assert.ok(
    jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart,
    `npm pack --json did not return a JSON array; stdout was: ${packJson.slice(0, 200)}`,
  );
  const [packResult] = JSON.parse(packJson.slice(jsonStart, jsonEnd + 1));
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

  const installedPackageRoot = join(consumerDir, "node_modules", "bip158");
  const installedPackageStat = await lstat(installedPackageRoot);
  assert.equal(installedPackageStat.isDirectory(), true);
  assert.equal(installedPackageStat.isSymbolicLink(), false);
  assert.notEqual(
    await realpath(installedPackageRoot),
    await realpath(packageRoot),
  );
  assert.deepEqual(
    (await listFiles(installedPackageRoot)).sort(),
    intendedFiles,
  );
  console.log("npm install: isolated tarball consumer installed without scripts");

  const bunSmoke = `
import assert from "node:assert/strict";
import {
  buildBasicFilter,
  bytesToHex,
  hexToBytes,
  matchAnyBasicFilters,
} from "bip158";

const resolved = import.meta.resolve("bip158");
assert.ok(
  resolved.endsWith("/src/index.ts") || resolved.endsWith("\\\\src\\\\index.ts"),
  \`expected resolve path to end with src/index.ts, got \${resolved}\`,
);

const blockHashDisplay = hexToBytes(
  "000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943",
);
const coinbaseScript = hexToBytes(
  "4104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac",
);

const filter = buildBasicFilter({
  blockHashDisplay,
  elements: [coinbaseScript],
});
assert.equal(bytesToHex(filter), "019dfca8");
assert.deepEqual(
  matchAnyBasicFilters([filter], [blockHashDisplay], [coinbaseScript]),
  [true],
);

const rn = await import("./node_modules/bip158/src/react-native.ts");
assert.equal(typeof rn.buildBasicFilter, "function");
assert.equal(
  rn.bytesToHex(
    rn.buildBasicFilter({
      blockHashDisplay,
      elements: [coinbaseScript],
    }),
  ),
  "019dfca8",
);

console.log(\`Bun \${Bun.version}: source package import and filter behavior passed\`);
`;

  const bunSmokePath = join(consumerDir, "bun-smoke.mjs");
  await writeFile(bunSmokePath, bunSmoke);
  console.log(run("bun", [bunSmokePath], { cwd: consumerDir }));
} finally {
  await rm(tempRoot, { force: true, recursive: true });
}
