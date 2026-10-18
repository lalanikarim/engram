# Pi Durable Brainstorm — Responses
Date: 2026-10-18T18:17:36.780Z

## A. What we build (purpose & scope)
A1 primary purpose: Personal assistant / project brain
A2 users: Just me
A3 work types: Shell / system administration; Web research / browsing; Data analysis (databases, files, spreadsheets); Monitoring & scheduled checks (“verify X daily”, “alert if Y”); Read/analyze code and answer questions; Edit code + run tests/builds locally
A4 autonomy: Autonomous, but dangerous/external actions require human approval (hooks + memos)
A5 task duration: Indefinite / standing conversations (weeks+, with compaction)
A6 concurrency: Parallel subagent workstreams inside one task
A7 multi-agent: Yes — core to the design (orchestrator + specialized workers)
A8 tools: Web search / fetch; Browser automation (forms, JS-heavy sites); Other tools: codemode, easily extensible using config without needing code changes
A9 memory: Searchable knowledge base (my docs, project wikis)

## B. How we host it
B1 where: Always-on home server / spare machine (Mac mini, Pi 5, …)
B2 availability: 24/7 on one box (auto-restart on crash)
B3 packaging: Single Docker container
B4 storage: SQLite (built-in, simplest — accept last-commit loss on hard power failure)
B5 tool execution: Mix: local for dev, sandboxed for untrusted clients
B6 agent count: Many / dynamic — spawn per project or ticket
B7 budget & constraints: no cloud spend

## C. How we access it (clients)
C1 primary surface: Chat platform bot
C2 additional surfaces: Email (email the agent, get replies by email); Other agents driving it (agent-to-agent; MCP bridge); Dashboards (costs, todos, run status — read-only); Scheduled/cron submissions from scripts
C3 simultaneous humans: 1
C4 interaction style: Mixed
C5 streaming: Both, per client
C6 exposure & auth: Localhost / trusted LAN only
C7 must-integrate systems: nothing yet out of the box. will decide later.

## D. Reliability & safety (where Pi Durable earns its keep)
D1 crash recovery importance: Critical — it drives real work (deploys, payments, external side effects); exactly-once matters
D2 risk tolerance: External side effects allowed with human approval gates (hooks + memos)
D3 cost control: None — run it as long as needed
D4 models: only local models accessible over the network via OpenAI compatible endpoints

## E. Free-form wrap-up
E1 hero use case: i would like to build and deploy
E2 hard constraints: security. we don't want to lose control of the agent to hackers or malware. while this is an ambitious goal, we must try what we can to mitigate it.
E3 MVP in 2 weeks: 2 clients - telegram, web ui, web fetch and some local code generation and testing, access conversations and continue any conversation easily.
E4 missed / other use case: I would like to use this to run research tasks, build and tweak apps, mostly web, that would be readily accessible over the network, generate and share reports accessible over the network, etc.