// Subagent pattern (PoC Phase 3a, productionized): a durable `mvp.worker` task that owns a
// worker conversation with role-restricted tools, plus a `delegate` tool for parallel fan-out.
// Roles come from app/roles.json (name → tools + instructions).
import { Type } from "@earendil-works/pi-ai";
import type { ConversationId, ModelRef, TaskId } from "@earendil-works/pi-durable";
import { configure, defineExtension, defineTask, defineTool } from "@earendil-works/pi-durable";
import type { RoleConfig } from "../config.ts";
import { defaultModelRef, parseModelRef, type ModelsConfig } from "../model.ts";

type WorkerInput = { role: string; prompt: string; model: ModelRef };
type WorkerState = { phase: "spawn" } | { phase: "wait"; convId: number };
type WorkerResult = { answer: string };

function resolveRole(role: string, roles: RoleConfig[]) {
  const cfg = roles.find((r) => r.name === role);
  if (!cfg) throw new Error(`unknown role "${role}" — available: ${roles.map((r) => r.name).join(", ")}`);
  return cfg;
}

/**
 * Resolve a worker's model: the role's own `model` (if declared), else the calling
 * conversation's model, else the global default chain.
 */
async function resolveWorkerModel(cfg: ModelsConfig, roleCfg: RoleConfig, parentModel: ModelRef | undefined): Promise<ModelRef> {
  if (roleCfg.model) return parseModelRef(cfg.models, roleCfg.model);
  if (parentModel) return parentModel;
  return defaultModelRef(cfg);
}

export function subagentExtension(roles: RoleConfig[], cfg: ModelsConfig) {
  const roleNames = roles.map((r) => r.name);

  const workerTask = defineTask<WorkerInput, WorkerState, WorkerResult>({
    name: "mvp.worker",
    version: 1,
    initial: () => ({ phase: "spawn" }),
    phases: {
      spawn: async (task, runtime, ctx) => {
        const roleCfg = resolveRole(task.input.role, roles);
        // Resolve the role's tool names to registered tools from the current registry snapshot.
        const tools = runtime.registry
          .installed()
          .flatMap((e) => e.tools ?? [])
          .filter((t) => roleCfg.tools.includes(t.name));
        // Assigned inside the commit callback; definite-assignment assertion — createConversation always yields an id.
        let convId!: number;
        await runtime.commit(async (tx) => {
          const rec = await tx.createConversation({
            ownership: { kind: "task", taskId: task.id },
          });
          await configure(tx, rec.id, {
            model: task.input.model,
            thinkingLevel: "medium",
            tools,
            instructions: roleCfg.instructions,
          });
          convId = rec.id;
          return undefined; // state transition happens in the next commit
        }, ctx);
        const handle = await runtime.conversation(convId as ConversationId, ctx);
        if (handle === undefined) throw new Error("worker conversation missing");
        await handle.submit({ type: "input", content: task.input.prompt, requestId: `worker-${task.id}` }, ctx);
        await runtime.commit(
          () => ({ status: "running" as const, checkpoint: { phase: "wait" as const, convId } }),
          ctx,
        );
      },
      wait: async (task, runtime, ctx) => {
        const convId = task.state.checkpoint.convId;
        const handle = await runtime.conversation(convId as ConversationId, ctx);
        if (handle === undefined) throw new Error("worker conversation missing");
        await handle.waitForIdle(ctx);
        const view = await runtime.context(convId as ConversationId, ctx);
        let answer = "";
        for (const m of [...view.messages].reverse()) {
          if (m.role !== "assistant") continue;
          const text = m.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join(" ")
            .trim();
          if (text) {
            answer = text;
            break;
          }
        }
        // A `terminal` commit is stored as `completing` until owned work drains.
        if (answer === "") {
          await runtime.commit(
            () => ({ status: "terminal" as const, outcome: { status: "failed" as const, error: { message: "worker produced no final answer" } } }),
            ctx,
          );
          return;
        }
        await runtime.commit(
          () => ({ status: "terminal" as const, outcome: { status: "completed" as const, result: { answer } } }),
          ctx,
        );
      },
    },
    abort: async (_task, runtime, ctx) => {
      await runtime.commit(
        () => ({ status: "terminal" as const, outcome: { status: "aborted" as const, reason: "worker aborted" } }),
        ctx,
      );
    },
  });

  const delegateTool = defineTool({
    name: "delegate",
    description:
      `Delegate one or more jobs to worker subagents that run in PARALLEL. Each job runs in its own conversation with ` +
      `role-restricted tools. Roles: ${roleNames.join(", ")}. With failFast=true, return as soon as any job fails ` +
      `(still-running jobs are reported as "running" and continue in the background).`,
    parameters: Type.Object({
      jobs: Type.Array(Type.Object({ role: Type.String(), prompt: Type.String() })),
      failFast: Type.Optional(Type.Boolean()),
    }),
    replay: "unsafe", // spawns child tasks; the harness tracks them durably
    execute: async (args: { jobs: Array<{ role: string; prompt: string }>; failFast?: boolean }, api, ctx) => {
      if (args.jobs.length === 0) throw new Error("jobs must not be empty");
      // Worker model chain: role's own model > this conversation's model > global default.
      const parentModel = (await api.agent(ctx)).model;
      const ids: TaskId<WorkerResult>[] = [];
      for (const job of args.jobs) {
        const roleCfg = resolveRole(job.role, roles); // fail fast on unknown role before spawning anything
        ids.push(
          await api.createTask(
            workerTask,
            { ...job, model: await resolveWorkerModel(cfg, roleCfg, parentModel) },
            { ownership: { kind: "task", taskId: api.taskId } },
            ctx,
          ),
        );
      }

      const results: Array<{ role: string; answer?: string; error?: string }> = new Array(args.jobs.length).fill(null);
      let sawFailure = false;
      await new Promise<void>((resolve) => {
        let pending = ids.length;
        const settle = () => {
          if (--pending === 0 || (args.failFast && sawFailure)) resolve();
        };
        ids.forEach((id, i) => {
          api
            .waitForTask<WorkerResult>(id, ctx)
            .then((s) => {
              const outcome = s.state.outcome;
              results[i] =
                outcome.status === "completed"
                  ? { role: args.jobs[i].role, answer: outcome.result.answer }
                  : { role: args.jobs[i].role, error: outcome.error?.message ?? outcome.status };
              if (results[i].error) sawFailure = true;
              settle();
            })
            .catch((err: unknown) => {
              results[i] = { role: args.jobs[i].role, error: String(err) };
              sawFailure = true;
              settle();
            });
        });
      });

      const final = results.map((r, i) => r ?? { role: args.jobs[i].role, answer: undefined, error: undefined });
      // Jobs still running when failFast fired keep executing in the background; their answers are
      // durably stored in their owned conversations.
      const running = final.filter((r) => !r.answer && !r.error);
      const text = JSON.stringify(final.map((r) => (running.includes(r) ? { ...r, running: true } : r)), null, 2);
      return { output: [{ type: "text" as const, text }] };
    },
  });

  return defineExtension({ name: "subagents", tools: [delegateTool], tasks: [workerTask] });
}
