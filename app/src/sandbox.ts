// Podman-backed sandboxed ExecutionEnv for untrusted code execution (D12–13).
// - Code executes inside a disposable container (`podman exec -w /sandbox <cid>`).
// - The host workspace dir is bind-mounted at /sandbox; file ops delegate to a host
//   NodeExecutionEnv over the same files, guarded so paths cannot escape the workspace.
// - No host env vars cross into the container (`podman exec` inherits container env only);
//   egress is limited via --network (default: none).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT, withCancel, type Context } from "@earendil-works/chord/context";
import { watchEvents } from "@earendil-works/pi-durable";
import type { ConversationId, EnvTarget, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { ExecutionError, FileError, err, ok } from "@earendil-works/pi-durable/env";
import type {
  BinaryReader,
  DirReader,
  FileInfo,
  Result,
  ShellExecOptions,
  ShellExecResult,
  FileWatcher,
  TextLineReader,
  WatchChange,
  WatchTarget,
} from "@earendil-works/pi-durable/env";
import { ConversationMeta } from "./meta.ts";

/** Name prefix for all sandbox containers; startup sweep removes orphans with this prefix. */
export const CONTAINER_PREFIX = "pi-sbx-";

/** Same cap as NodeExecutionEnv (2^31 - 1 ms). */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Contract (mirrors NodeExecutionEnv.resolveTimeoutMs): `timeout` is in SECONDS. */
function resolveTimeoutMs(timeout: number | undefined): Result<number | undefined, ExecutionError> {
  if (timeout === undefined) return ok(undefined);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
  }
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`));
  }
  return ok(timeoutMs);
}

export class PodmanSandboxEnv {
  readonly id: string;
  private workspace: string;
  private image: string;
  private network: string;
  private containerId: string;
  private inner: NodeExecutionEnv;
  ready = false;

  constructor(options: { workspace: string; image?: string; network?: string }) {
    this.workspace = options.workspace; // absolute host path
    this.image = options.image ?? "docker.io/library/python:3.12-alpine";
    this.network = options.network ?? "none";
    this.containerId = `${CONTAINER_PREFIX}${randomBytes(4).toString("hex")}`;
    this.inner = new NodeExecutionEnv({ cwd: this.workspace });
    this.id = `podman:${this.containerId}`;
  }

  async init(context: Context): Promise<void> {
    mkdirSync(this.workspace, { recursive: true });
    await this.#podman(
      [
        "run", "-d", "--name", this.containerId,
        "--network", this.network,
        "-v", `${this.workspace}:/sandbox`,
        this.image, "sleep", "infinity",
      ],
      context,
    );
    this.ready = true;
  }

  #podman(args: string[], context: Context): Promise<string> {
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

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (!this.ready) return err(new ExecutionError("spawn_error", "sandbox not initialized"));
    const timeoutResult = resolveTimeoutMs(options?.timeout);
    if (!timeoutResult.ok) return timeoutResult;
    const timeoutMs = timeoutResult.value;
    const finalArgs = ["exec", "-w", "/sandbox", this.containerId];
    // typeof (not Array.isArray): the guard must narrow `readonly string[]` out of the else branch.
    if (typeof command === "string") finalArgs.push("sh", "-lc", command);
    else finalArgs.push(...command);
    return new Promise((resolve, reject) => {
      const child = spawn("podman", finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
      let timedOut = false;
      let aborted = false;
      const timer = timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeoutMs)
        : null;
      const onAbort = () => {
        aborted = true;
        child.kill("SIGKILL");
      };
      context?.abortSignal?.addEventListener?.("abort", onAbort, { once: true });
      const emit = (stream: "stdout" | "stderr") => (d: Buffer) => {
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
        if (timedOut) resolve(err(new ExecutionError("timeout", `timeout:${options?.timeout}`)));
        else if (aborted) resolve(err(new ExecutionError("aborted", "command aborted")));
        else resolve(ok({ exitCode: code ?? 1 }));
      });
    });
  }

  /** Containment guard: the canonical path must be the workspace or below it.
   * Canonicalizes the deepest EXISTING ancestor so writes to new files work, while
   * still resolving symlinks that could escape the workspace. */
  async #guard(path: string, context: Context): Promise<Result<undefined, FileError>> {
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
  get cwd(): string {
    return this.inner.cwd;
  }
  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.openTextLineReader(path, context);
  }
  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.readTextFile(path, context);
  }
  async readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.readTextLines(path, options, context);
  }
  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.readBinaryFile(path, context);
  }
  async openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.openBinaryReader(path, options, context);
  }
  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.writeFile(path, content, context);
  }
  async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.appendFile(path, content, context);
  }
  async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.truncateFile(path, size, context);
  }
  async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.flushFile(path, context);
  }
  async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    const g1 = await this.#guard(sourcePath, context);
    if (!g1.ok) return g1;
    const g2 = await this.#guard(destinationPath, context);
    if (!g2.ok) return g2;
    return this.inner.renameFile(sourcePath, destinationPath, context);
  }
  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.fileInfo(path, context);
  }
  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const g = await this.#guard(path ?? ".", context);
    if (!g.ok) return g;
    return this.inner.listDir(path, context);
  }
  async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    const g = await this.#guard(path ?? ".", context);
    if (!g.ok) return g;
    return this.inner.openDirReader(path, context);
  }
  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.canonicalPath(path, context);
  }
  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const g = await this.#guard(path, context);
    if (!g.ok) return ok(false); // outside the sandbox: does not exist here
    return this.inner.exists(path, context);
  }
  async createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.createDir(path, options, context);
  }
  async remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const g = await this.#guard(path, context);
    if (!g.ok) return g;
    return this.inner.remove(path, options, context);
  }
  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.inner.createTempDir(prefix, context); // lands inside workspace cwd
  }
  async createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    return this.inner.createTempFile(options, context);
  }
  absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
    return this.inner.absolutePath(path, _context);
  }
  joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
    return this.inner.joinPath(parts, _context);
  }
  watch(
    targets: readonly WatchTarget[],
    onChange: (change: WatchChange) => void,
    context: Context,
  ): Promise<Result<FileWatcher, FileError>> {
    return this.inner.watch(targets, onChange, context);
  }

  async cleanup(context: Context): Promise<void> {
    if (!this.ready) return;
    this.ready = false;
    try {
      await this.#podman(["rm", "-f", this.containerId], context);
    } catch (e) {
      console.error("sandbox cleanup:", (e as Error).message);
    }
  }
}

interface CachedSandbox {
  env: PodmanSandboxEnv;
  stopStream: () => Promise<unknown>;
  /** Cancels the event watch's lifetime (independent of the spawning call's context). */
  cancelWatch: () => void;
}

/**
 * Routes sandboxed conversations into per-conversation Podman sandboxes.
 * The harness env factory runs on every tool call, so live envs are cached per
 * conversation; each is disposable per task — the container is removed when the
 * conversation's run ends and recreated for the next run.
 */
export class SandboxManager {
  private workRoot: string;
  private image: string;
  private network: string;
  private harness: Harness | undefined;
  private cache = new Map<ConversationId, CachedSandbox>();
  private creating = new Map<ConversationId, Promise<PodmanSandboxEnv>>();

  constructor(options: { workRoot: string; image: string; network: string }) {
    this.workRoot = options.workRoot;
    this.image = options.image;
    this.network = options.network;
  }

  /** The harness is only needed once sandboxes actually spawn, which is after open(). */
  attach(harness: Harness): void {
    this.harness = harness;
  }

  /** The sandboxed env for this target, or null when the conversation is not sandboxed. */
  async envFor(target: EnvTarget, context: Context): Promise<PodmanSandboxEnv | null> {
    const meta = await target.read.snapshot(ConversationMeta, target.conversationId, context);
    if (meta?.sandbox !== true) return null;
    const conversationId: ConversationId = target.conversationId;
    const dir = target.cwd ? join(this.workRoot, target.cwd) : this.workRoot;
    mkdirSync(dir, { recursive: true });

    const existing = this.cache.get(target.conversationId);
    if (existing) return existing.env;
    const inflight = this.creating.get(target.conversationId);
    if (inflight) return inflight;

    const promise = this.#spawn(dir, conversationId, context);
    this.creating.set(target.conversationId, promise);
    try {
      return await promise;
    } finally {
      if (this.creating.get(target.conversationId) === promise) this.creating.delete(target.conversationId);
    }
  }

  async #spawn(dir: string, conversationId: ConversationId, context: Context): Promise<PodmanSandboxEnv> {
    const env = new PodmanSandboxEnv({ workspace: dir, image: this.image, network: this.network });
    await env.init(context);
    // Disposable per task: tear the container down when this conversation's run ends.
    // The watch must outlive the spawning call: watchEvents' stream lifetime is governed by its
    // acquisition context, so derive a child from BACKGROUND_CONTEXT (no inherited abort) that we
    // alone can cancel — otherwise the watch dies with the first run and never sees that run_end
    // (nor any later run's events).
    const { context: watchContext, cancel } = withCancel(BACKGROUND_CONTEXT);
    if (this.harness) {
      const stream = await watchEvents(this.harness, conversationId, watchContext);
      let disposed = false;
      stream.start(async (events, context) => {
        if (disposed || !events.some((e) => e.type === "run_end")) return;
        disposed = true;
        this.cache.delete(conversationId);
        await env.cleanup(context);
        await stream.stop();
      });
      this.cache.set(conversationId, { env, stopStream: () => stream.stop(), cancelWatch: cancel });
    } else {
      this.cache.set(conversationId, { env, stopStream: async () => undefined, cancelWatch: cancel });
    }
    return env;
  }

  /** Remove orphaned sandbox containers left behind by a crashed previous run. */
  async sweepOrphans(context: Context): Promise<string[]> {
    let names: string;
    try {
      names = await this.#rawPodman(["ps", "-a", "--filter", `name=${CONTAINER_PREFIX}`, "--format", "{{.Names}}"], context);
    } catch (e) {
      throw new Error(`sandbox orphan sweep failed: ${(e as Error).message}`);
    }
    const orphans = names.split("\n").map((s) => s.trim()).filter(Boolean);
    for (const name of orphans) {
      try {
        await this.#rawPodman(["rm", "-f", name], context);
      } catch (e) {
        console.error(`sandbox orphan removal failed for ${name}:`, (e as Error).message);
      }
    }
    return orphans;
  }

  /** Tear down every live sandbox (shutdown path). */
  async disposeAll(context: Context): Promise<void> {
    const entries = [...this.cache.values()];
    this.cache.clear();
    for (const entry of entries) {
      entry.cancelWatch();
      await entry.env.cleanup(context);
      await entry.stopStream().catch(() => undefined);
    }
  }

  #rawPodman(args: string[], context: Context): Promise<string> {
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
}

