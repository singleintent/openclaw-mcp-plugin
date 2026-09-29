#!/usr/bin/env node
/**
 * Publish preflight.
 *
 * Every item in this repo has been verified the same way by hand: clean tree,
 * pushed, and the pushed state checked from a fresh clone rather than from the
 * working directory. This encodes that as a gate so it holds on the one occasion
 * it matters most and nobody is watching — a publish is irreversible in a way a
 * commit is not, since a version number cannot be reused once taken.
 *
 * ## Why `prepublishOnly` and not one of the neighbouring hooks
 *
 * Measured on npm 11.19.0 with a throwaway package, rather than recalled:
 *
 *   npm publish --dry-run   prepublishOnly, prepack, prepare, postpack, publish
 *   npm pack                                prepack, prepare, postpack
 *   npm ci                  (nothing)
 *   npm install                                      prepare,          prepublish
 *
 * `prepublishOnly` is the only hook that fires for a publish and for nothing
 * else. `prepare` would fire on `npm pack` *and* on `npm install`, so a consumer
 * installing this package from the registry would run a git-and-test gate against
 * whatever repository they happened to be sitting in — which would fail, and
 * would deserve to be reported as a bug in this package. `prepublish` is worse
 * and is deprecated besides. That difference is the whole reason this file is
 * wired where it is.
 *
 * Note it does fire on `--dry-run`, which is deliberate and useful: a rehearsal
 * that skipped the gate would rehearse the wrong thing.
 *
 * ## Order
 *
 * Cheapest and most likely first, so the common failure is reported in
 * milliseconds: a dirty tree needs no network and no build, the sync check needs
 * one fetch, and the tests need a full compile. Running tests first would make
 * the most frequent mistake the slowest to hear about.
 */
import { execFileSync } from "node:child_process";

/** Run a command for its output, trimmed. Throws with stderr attached. */
function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Fail with a message that names the condition and how to clear it. */
function refuse(condition, detail) {
  console.error(`\npublish refused — ${condition}\n\n${detail}\n`);
  process.exit(1);
}

const BRANCH = "main";
const REMOTE = "origin";

// 1. Clean tree. --porcelain is stable across git versions; untracked files count,
//    because an untracked file is something that is about to be either shipped or
//    lost, and either way the answer is to decide before publishing rather than
//    after.
const dirty = run("git", ["status", "--porcelain"]);
if (dirty !== "") {
  refuse(
    "the working tree is dirty",
    `Commit, stash or ignore these first:\n\n${dirty}`,
  );
}

// 2. HEAD is exactly origin/main. Fetched rather than read from the local ref,
//    because a stale remote-tracking ref would let this pass while the branch had
//    moved — which is precisely the state the check exists to catch.
try {
  run("git", ["fetch", REMOTE, BRANCH, "--quiet"]);
} catch (error) {
  refuse(
    `could not reach ${REMOTE} to verify the branch is in sync`,
    `Publishing needs the network anyway, so this is not worth working around.\n${String(error.stderr ?? error)}`,
  );
}

const head = run("git", ["rev-parse", "HEAD"]);
const remote = run("git", ["rev-parse", `${REMOTE}/${BRANCH}`]);

if (head !== remote) {
  // Say which direction, because "ahead" and "behind" call for opposite actions.
  const ahead = run("git", ["rev-list", "--count", `${remote}..${head}`]);
  const behind = run("git", ["rev-list", "--count", `${head}..${remote}`]);
  const direction =
    Number(ahead) > 0 && Number(behind) > 0
      ? `diverged: ${ahead} commit(s) ahead and ${behind} behind`
      : Number(ahead) > 0
        ? `${ahead} commit(s) ahead — push first`
        : `${behind} commit(s) behind — pull first`;
  refuse(
    `HEAD is not ${REMOTE}/${BRANCH}`,
    `HEAD             ${head}\n${REMOTE}/${BRANCH}      ${remote}\n\n${direction}`,
  );
}

// 3. Tests. Inherit stdio so a failure shows the real reporter output rather than
//    this script's summary of it.
try {
  execFileSync("npm", ["test"], { stdio: "inherit" });
} catch {
  refuse("the test suite failed", "The output above is the reason. Nothing was published.");
}

console.log(`\npublish preflight passed — clean tree, HEAD == ${REMOTE}/${BRANCH} (${head.slice(0, 7)}), tests green\n`);
