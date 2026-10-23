# Using this agent

This knowledge base holds notes about how to use the project-brain agent. Search it with `kb_search`.

## Talking to the agent

- **Tasks**: send a task via any client (Telegram, Web UI). Each submission carries a stable
  `requestId`; resubmitting the same `requestId` is a no-op (exactly-once semantics).
- **Steering**: while a run is in progress you can steer it — the new input interrupts the current
  turn and the agent continues from there.
- **Conversations**: the root conversation is your standing assistant. Project conversations get
  their own workspace directory under `/work/<project>`; open any of them at any time to continue it.

## Approvals

Actions with external side effects (sending messages/email, deploying, payments, writes outside
your workspaces) are approval-gated. When the agent needs one, it stops and reports an approval
request. A human approves or denies it via the client; the decision is durable across crashes.
The agent cannot approve its own actions, and an approved action runs exactly once even if the
run is retried after a crash.

## Subagents

`delegate` fans out parallel jobs to worker subagents, each in its own conversation:

- **researcher** — web access only (no shell, no writes); safe for untrusted content.
- **worker** — files + shell in its own workspace.

Use `failFast: true` when a failed job should short-circuit the batch.

## Memory & durability

- Everything is durable: crash mid-run and the agent resumes from its checkpoint on restart.
- Long conversations are compacted automatically; summaries preserve the facts that matter.
- Knowledge base notes live in `/kb` — add project notes there and the agent can search them.
