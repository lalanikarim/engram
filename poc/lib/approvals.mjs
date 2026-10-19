// Approval gating (A6): a beforeTool hook that blocks a dangerous tool until a
// human decision is stored durably in a session doc family.
// - Key = sha1(tool name + arguments) so a retry with identical args finds the same decision.
// - The hook can only READ the decision; only the driver (standing in for Telegram) writes it,
//   so the agent cannot self-approve.
import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineDocFamily, defineTool, hook, ToolTask } from "@earendil-works/pi-durable";

export const DANGEROUS_TOOL = "dangerous_action";

export const ApprovalDoc = defineDocFamily({
  family: true,
  scope: "session",
  kind: "poc.approval",
  version: 1,
  initial: () => ({ decision: "pending", decidedBy: null }),
});

/** Stable approval key for a call: identical args on retry map to the same key. */
export function approvalKeyFor(name, arguments_) {
  return createHash("sha1")
    .update(name)
    .update(JSON.stringify(arguments_ ?? {}))
    .digest("hex")
    .slice(0, 12);
}

export function dangerousTool() {
  return defineTool({
    name: DANGEROUS_TOOL,
    description:
      "Perform a sensitive external action (simulated outgoing send). This tool requires human approval before it can run.",
    parameters: Type.Object({ message: Type.String() }),
    replay: "safe",
    execute: async (args) => ({
      output: [{ type: "text", text: `ACTION EXECUTED: sent "${args.message}"` }],
    }),
  });
}

export function approvalHook() {
  return hook(ToolTask, {
    beforeTool: async (call, api, ctx) => {
      if (call.name !== DANGEROUS_TOOL) return undefined;
      const key = approvalKeyFor(call.name, call.arguments);
      const rec = await api.snapshot(ApprovalDoc, key, ctx);
      if (rec?.decision === "approved") return undefined; // allow
      return {
        block: `BLOCKED: ${call.name} requires human approval before it can run. Approval key: ${key}. Tell the user this action needs their explicit approval and do not retry until they approve it.`,
      };
    },
  });
}
