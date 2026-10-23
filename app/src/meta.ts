// Conversation display metadata: name + creation time, one per conversation.
import { defineDoc } from "@earendil-works/pi-durable";

export const ConversationMeta = defineDoc({
  scope: "conversation",
  history: "latest",
  fork: "current",
  kind: "mvp.meta",
  version: 1,
  initial: () => ({ name: "", createdAt: 0 }),
});
