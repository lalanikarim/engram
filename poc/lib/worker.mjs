// Subagent pattern: a durable `poc.worker` task that owns a worker conversation
// with role-restricted tools, plus a `delegate` tool for parallel fan-out.
import { Type } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  configure,
  defineTask,
  defineTool,
} from "@earendil-works/pi-durable";

const ROLE_TOOLS = {
  researcher: ["web_fetch"],
  worker: ["read", "write", "edit", "bash"],
};

export const workerTask = defineTask({
  name: "poc.worker",
  version: 1,
  initial: () => ({ phase: "spawn" }),
  phases: {
    spawn: async (task, runtime, ctx) => {
      const { role, prompt } = task.input;
      const tools = runtime.registry
        .installed()
        .flatMap((e) => e.tools ?? [])
        .filter((t) => (ROLE_TOOLS[role] ?? []).includes(t.name));
      let convId;
      await runtime.commit(async (tx) => {
        const rec = await tx.createConversation({
          ownership: { kind: "task", taskId: task.id },
        });
        await configure(tx, rec.id, {
          model: { provider: "aurora", modelId: task.input.modelId },
          thinkingLevel: "medium",
          tools,
        });
        convId = rec.id;
        return undefined; // state transition happens in the next commit
      }, ctx);
      const handle = await runtime.conversation(convId, ctx);
      if (handle === undefined) throw new Error("worker conversation missing");
      await handle.submit(
        { type: "input", content: prompt, requestId: `worker-${task.id}` },
        ctx,
      );
      await runtime.commit(
        () => ({ status: "running", checkpoint: { phase: "wait", convId } }),
        ctx,
      );
    },
    wait: async (task, runtime, ctx) => {
      const convId = task.state.checkpoint.convId;
      const handle = await runtime.conversation(convId, ctx);
      if (handle === undefined) throw new Error("worker conversation missing");
      await handle.waitForIdle(ctx);
      const view = await runtime.context(convId, ctx);
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
      if (answer === "") {
        await runtime.commit(
          () => ({
            status: "completing",
            outcome: { status: "failed", error: { message: "worker produced no final answer" } },
          }),
          ctx,
        );
        return;
      }
      await runtime.commit(
        () => ({ status: "completing", outcome: { status: "completed", result: { answer } } }),
        ctx,
      );
    },
  },
  abort: async (task, runtime, ctx) => {
    await runtime.commit(
      () => ({ status: "completing", outcome: { status: "aborted", reason: "worker aborted" } }),
      ctx,
    );
  },
});

export function delegateTool() {
  return defineTool({
    name: "delegate",
    description:
      "Delegate one or more jobs to worker subagents that run in parallel. Each job runs in its own conversation with role-restricted tools (researcher: web_fetch only; worker: file+shell tools). Returns each job's final answer.",
    parameters: Type.Object({
      jobs: Type.Array(
        Type.Object({
          role: Type.Union([Type.Literal("researcher"), Type.Literal("worker")]),
          prompt: Type.String(),
        }),
      ),
    }),
    replay: "unsafe", // spawns child tasks; the harness tracks them durably
    execute: async (args, api, ctx) => {
      const ids = [];
      for (const job of args.jobs) {
        ids.push(
          await api.createTask(
            workerTask,
            { ...job, modelId: "ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF" },
            { ownership: { kind: "task", taskId: api.taskId } },
            ctx,
          ),
        );
      }
      const settled = await Promise.all(ids.map((id) => api.waitForTask(id, ctx)));
      const results = settled.map((s, i) => ({
        role: args.jobs[i].role,
        ...(s.state.outcome.status === "completed"
          ? { answer: s.state.outcome.result.answer }
          : { error: s.state.outcome.error?.message ?? s.state.outcome.status }),
      }));
      return { output: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    },
  });
}
