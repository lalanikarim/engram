// Podman-backed ExecutionEnv for untrusted code (A7).
// - Code executes inside a disposable container (`podman exec`), cwd /sandbox.
// - The host workspace dir is bind-mounted at /sandbox, so file tools operate on
//   the same files through NodeExecutionEnv — guarded to stay inside the workspace.
// - No host env vars are passed; egress limited via --network (default: none).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { FileError, ExecutionError, ok, err } from "@earendil-works/pi-durable/env";

export class PodmanSandboxEnv {
  constructor({ workspace, image = "docker.io/library/python:3.12-alpine", network = "none" }) {
    this.workspace = workspace; // absolute host path
    this.image = image;
    this.network = network;
    this.containerId = `pi-sbx-${randomBytes(4).toString("hex")}`;
    this.inner = new NodeExecutionEnv({ cwd: workspace });
    this.ready = false;
  }

  get id() {
    return `podman:${this.containerId}`;
  }

  async init(context) {
    mkdirSync(this.workspace, { recursive: true });
    await this.#podman(
      ["run", "-d", "--name", this.containerId, "--network", this.network, `-v`, `${this.workspace}:/sandbox`, this.image, "sleep", "infinity"],
      context,
    );
    this.ready = true;
  }

  #podman(args, context) {
    return new Promise((resolve, reject) => {
      const child = spawn("podman", args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let errOut = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (errOut += d));
      const onAbort = () => child.kill("SIGKILL");
      context?.abortSignal?.addEventListener?.("abort", onAbort, { once: true });
      child.on("error", reject);
      child.on("close", (code) => {
        context?.abortSignal?.removeEventListener?.("abort", onAbort);
        if (code === 0) resolve(out.trim());
        else reject(new Error(`podman ${args[0]} failed (${code}): ${(errOut || out).trim()}`));
      });
    });
  }

  async exec(command, options, context) {
    if (!this.ready) return err(new ExecutionError("spawn_error", "sandbox not initialized"));
    const finalArgs = ["exec", "-w", "/sandbox", this.containerId];
    if (Array.isArray(command)) finalArgs.push(...command);
    else finalArgs.push("sh", "-lc", command);
    return new Promise((resolve, reject) => {
      const child = spawn("podman", finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
      let timedOut = false;
      let aborted = false;
      const timer = options?.timeout
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeout)
        : null;
      const onAbort = () => {
        aborted = true;
        child.kill("SIGKILL");
      };
      context?.abortSignal?.addEventListener?.("abort", onAbort, { once: true });
      const emit = (stream) => (d) => {
        if (options?.onOutput) options.onOutput(d.toString(), context, { stream });
      };
      child.stdout.on("data", emit("stdout"));
      child.stderr.on("data", emit("stderr"));
      const finish = () => {
        if (timer) clearTimeout(timer);
        context?.abortSignal?.removeEventListener?.("abort", onAbort);
      };
      child.on("error", (e) => {
        finish();
        reject(new ExecutionError("spawn_error", String(e)));
      });
      child.on("close", (code) => {
        finish();
        if (timedOut) resolve(err(new ExecutionError("timeout", `command timed out after ${options?.timeout}ms`)));
        else if (aborted) resolve(err(new ExecutionError("aborted", "command aborted")));
        else resolve(ok({ exitCode: code ?? 1 }));
      });
    });
  }

  /** Containment guard: the canonical path must be the workspace or below it.
   * Canonicalizes the deepest EXISTING ancestor so writes to new files work, while
   * still resolving symlinks that could escape the workspace. */
  async #guard(path, context) {
    const abs = await this.inner.absolutePath(path, context);
    if (!abs.ok) return abs;
    const root = await this.inner.canonicalPath(this.workspace, context);
    if (!root.ok) return root;
    // Walk up to the deepest existing ancestor and canonicalize it.
    let p = abs.value;
    for (;;) {
      const r = await this.inner.canonicalPath(p, context);
      if (r.ok) {
        const full = r.value + abs.value.slice(p.length); // remainder below the existing ancestor
        if (full !== root.value && !full.startsWith(root.value + "/")) {
          return err(new FileError("permission_denied", `path escapes sandbox workspace: ${path}`, path));
        }
        return ok(undefined);
      }
      const parent = dirname(p);
      if (parent === p) break;
      p = parent;
    }
    return err(new FileError("not_found", `no such path: ${path}`, path));
  }

  // ---- file ops: guarded delegation to the host view of /sandbox ----
  async readTextFile(path, context) {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.readTextFile(path, context);
  }
  async readTextLines(path, options, context) {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.readTextLines(path, options, context);
  }
  async readBinaryFile(path, context) {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.readBinaryFile(path, context);
  }
  async openBinaryReader(path, options, context) {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.openBinaryReader(path, options, context);
  }
  async writeFile(path, content, context) {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.writeFile(path, content, context);
  }
  async appendFile(path, content, context) {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.appendFile(path, content, context);
  }
  async truncateFile(path, size, context) {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.truncateFile(path, size, context);
  }
  async flushFile(path, context) {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.flushFile(path, context);
  }
  async renameFile(sourcePath, destinationPath, context) {
    const g1 = await this.#guard(sourcePath, context);
    if (!g1.ok) return g1;
    const g2 = await this.#guard(destinationPath, context);
    if (!g2.ok) return g2;
    return this.inner.renameFile(sourcePath, destinationPath, context);
  }
  async fileInfo(path, context) {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.fileInfo(path, context);
  }
  async listDir(path, context) {
    const g = await this.#guard(path ?? ".", context);
    if (!g.ok) return g;
    return this.inner.listDir(path, context);
  }
  async openDirReader(path, options, context) {
    const g = await this.#guard(path ?? ".", context);
    if (!g.ok) return g;
    return this.inner.openDirReader(path, options, context);
  }
  async canonicalPath(path, context) {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.canonicalPath(path, context);
  }
  async exists(path, context) {
    const g = await this.#guard(path, context);
    if (!g.ok) return ok(false); // outside the sandbox: does not exist here
    return this.inner.exists(path, context);
  }
  async createDir(path, options, context) {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.createDir(path, options, context);
  }
  async remove(path, options, context) {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.remove(path, options, context);
  }
  async createTempDir(prefix, context) {
    return this.inner.createTempDir(prefix, context); // lands inside workspace cwd
  }
  async createTempFile(options, context) {
    return this.inner.createTempFile(options, context);
  }
  absolutePath(path, context) {
    return this.inner.absolutePath(path, context);
  }
  joinPath(parts, context) {
    return this.inner.joinPath(parts, context);
  }
  watch(targets, onChange, context) {
    return this.inner.watch(targets, onChange, context);
  }

  async cleanup(context) {
    if (!this.ready) return;
    this.ready = false;
    try {
      await this.#podman(["rm", "-f", this.containerId], context);
    } catch (e) {
      console.error("sandbox cleanup:", e.message);
    }
  }
}
