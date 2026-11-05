# gates.json — operating the destructive floor (`destructiveArgs`)

This is an **operations** page for one knob in `app/gates.json`: the per-tool
`destructiveArgs` declaration added in v0.2.3 (issue #69). It tells you what to
write, and when writing it is a mistake. The design rationale lives in
[`plans/approvals.md`](plans/approvals.md) (§ "Effect-bearing arguments (G)") —
this page is how you operate what that plan built.

## What `destructiveArgs` does

The destructive floor is the safety tier that can never be auto-approved or
allow-listed: a call classified **destructive** always costs an explicit human
acknowledgement. The floor judges each call by its *effect-bearing* arguments —
the values that identify what gets changed — not by every string inside the
call. `gates.json: destructiveArgs` declares, per tool, which argument paths
carry the effect:

```json
"destructiveArgs": {
  "write": ["path"],
  "edit": ["edits[].path", "path"],
  "submit_verdict": []
}
```

Path syntax: `.` nests into objects, `[]` maps over an array (`edits[].path` =
the `path` of every entry in the `edits` array). A missing value at a declared
path simply yields no candidate — it is not an error.

**What each form means for safety, stated plainly:**

| Form | Meaning |
|---|---|
| `"write": ["path"]` | Only the value(s) at those paths are scanned for destructiveness. File contents, prose fields, and descriptions are **not** read as commands. This is what stops a test file whose cleanup is `rmSync(dir, {recursive: true})` from being classified DESTRUCTIVE. |
| `"submit_verdict": []` | That tool has **no destructive floor at all**. Its safety is whatever the tool itself enforces — nothing in its payload can ever escalate it to the destructive tier. Use this only for tools whose payload genuinely cannot be destructive (record a verdict, open a draft PR). Declaring `[]` does **not** ungat the tool: a declared tier (`"prompt"`) still applies — narrowing the floor removes the destructive escalation, nothing else. |
| *(entry absent)* | Every string argument is scanned. This is strict, and it is the default **for a reason**: unknown and custom tools never become weaker by default. A `db_exec` call with `DROP TABLE users` in its `sql` arg is still DESTRUCTIVE even though nobody declared `db_exec`. |

Two failure modes to know about — only one of them is loud:

- **Declaring a tool with too-narrow paths** → that tool's destructive floor
  silently stops applying. Nothing errors; the line in the next section tells you
  what got narrowed, so check it after deploying.
- **Not declaring at all** → back to per-call human approvals for prose: any tool
  whose payload merely *quotes* a dangerous string (`rm -rf`, `DROP TABLE`, …)
  costs a fresh destructive acknowledgement. That was the original #69 symptom.

## Worked example (correct as written)

This is a complete, minimal `gates.json`. The two coding-tool entries match the
shipped defaults exactly (re-declaring them is a harmless no-op and shows the
shape); `submit_verdict` is a deployment's own prose-only tool. Every evaluation
below it is asserted verbatim in [`app/test/gates-docs-verification.test.ts`](../app/test/gates-docs-verification.test.ts).

```json
{
  "tiers": [
    { "tool": "bash", "default": "prompt" },
    { "tool": "write", "default": "prompt" },
    { "tool": "edit", "default": "prompt" },
    { "tool": "submit_verdict", "default": "prompt" }
  ],
  "destructiveArgs": {
    "write": ["path"],
    "edit": ["edits[].path", "path"],
    "submit_verdict": []
  }
}
```

With this config:

| Call | Tier | Why |
|---|---|---|
| `write {path:"app/test/x.test.ts", content:"rm -rf /"}` | `prompt` | Only `path` is scanned; the content is text, not execution. |
| `write {path:"/Users/dev/.bashrc", content:"rm -rf /"}` | `destructive` | The *target* is destructive by identity (see below) — payload never read. |
| `edit {edits:[{path:"app/src/extensions/gates.ts", oldText:"\\brm\\s+…"}]}` | `prompt` | Only each edit's `path` is scanned; quoting the pattern list is not a command. |
| `submit_verdict {verdict:"fail", evidence:["sh -c \"rm -rf /tmp/x\""]}` | `prompt` | `[]` means no floor at all; the declared tier still applies. |
| `db_exec {sql:"DROP TABLE users"}` (never declared) | `destructive` | Absent entry → every string arg is scanned; strict default preserved. |

One replacement rule to internalise: naming a tool in `destructiveArgs`
**replaces** that tool's whole list, it does not merge into it. The shipped
default for `edit` is `["edits[].path", "path"]`; declaring `"edit":
["edits[].path"]` silently drops the bare `path` argument from the floor. If you
narrow a built-in tool, restate every path you still want scanned.

## The startup posture line

Declaring effect paths is a posture change, so the kernel announces it at
startup — same convention as the containment declaration. With the worked
example above, the line reads:

```console
[gates] destructive floor judges effect-bearing args only for: write(path), edit(edits[].path,path), multi_edit(edits[].path,path), submit_verdict(nothing scanned) — payload/prose is not scanned for these tools; device/credential/later-executed paths stay destructive
```

This line is the **posture check**. It prints on every startup (the shipped
coding tools `write`, `edit`, `multi_edit` always appear in it), and your own
`destructiveArgs` entries are appended — prose-only tools render as
`(nothing scanned)`. **If you deployed a `destructiveArgs` entry and did not see
your tool in this line, your config did not take effect.** Grep for the prefix:

```console
grep "\[gates\] destructive floor judges effect-bearing args only for:" <startup log>
```

## What stays destructive regardless — `PATH_DESTRUCTIVE_PATTERNS`

Narrowing the floor is safe only because a second, built-in list keeps targets
that are dangerous **by identity** destructive no matter what the payload says.
You cannot remove or override these (they are not part of `gates.json`). The
families:

- block devices and partitions (`/dev/sda`, `/dev/nvme0n1`, …);
- `.ssh/` directories and `authorized_keys`;
- account databases (`/etc/passwd`, `/etc/shadow`, `/etc/group`, `/etc/sudoers`) and `sshd_config`;
- files that execute later: shell rc files (`.bashrc`, `.zshrc`, …), `.git/hooks/`, cron/systemd units, macOS `Library/LaunchAgents`/`LaunchDaemons`.

That last family is the one that makes narrowing honest rather than merely
permissive — writing a dangerous line into a file that runs at next login is
destruction even though no command ran:

```console
write {path:"/Users/dev/.bashrc", content:"rm -rf /"}   → DESTRUCTIVE   // executes at next login
write {path:"app/test/x.test.ts", content:"rm -rf /"}   → not           // text is not execution
```

(Discard sinks `/dev/null`, `/dev/stdout`, `/dev/stderr`, `/dev/fd/*` are
deliberately *not* destructive: discarding output is not a write.)

## Choosing effect paths — the rule

Name the argument that identifies **what gets changed**: the file path, the
device, the table, the branch. Do **not** include arguments that carry user
text, file contents, or descriptions — those are exactly the strings the floor
used to misread as commands.

If you cannot name one, declaring `[]` is a statement that **the tool cannot be
destructive**. Make that statement explicit — `gates.json` is strict JSON (no
comments), so say it in the commit message or deployment note that ships the
config change — and get it reviewed before it goes live.

## Verifying this page

Every config snippet and tier claim above is compiled and evaluated by
[`app/test/gates-docs-verification.test.ts`](../app/test/gates-docs-verification.test.ts):

```bash
node app/test/gates-docs-verification.test.ts
```

It fails if any example in this document stops evaluating as documented.
