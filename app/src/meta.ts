// Conversation display metadata: name + creation time + sandbox flag, one per conversation.
// `sandbox` marks code-gen/test conversations whose execution routes into a Podman
// sidecar (D12–13). Optional at runtime so pre-existing docs (without the field) load
// unchanged; absent means false.
import { defineDoc } from "@earendil-works/pi-durable";

export const ConversationMeta = defineDoc({
  scope: "conversation",
  history: "latest",
  fork: "current",
  kind: "mvp.meta",
  version: 1,
  // Explicit return type: without it the doc token infers `sandbox` as the literal `false`.
  initial: (): { name: string; createdAt: number; sandbox: boolean } => ({
    name: "",
    createdAt: 0,
    sandbox: false,
  }),
});
