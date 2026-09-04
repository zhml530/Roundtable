# Coordinator Duo scheduling

Coordinator channels run at most two worker tasks concurrently per channel run.
The Coordinator proposes the task DAG; the runtime enforces dependencies and
the two-task limit. Independent tasks can overlap, and a released slot is
filled without waiting for the other task in the pair. The planning request
precedes worker execution. Other channels have their own limits.

```mermaid
flowchart TD
    Goal[Goal and mentions] --> Plan[Coordinator proposes assignments and dependencies]
    Plan --> Validate[Validate DAG and mentioned Bot coverage]
    Validate --> Ready[Ready tasks]
    Ready --> Dispatch[Runtime admits at most two tasks]
    Dispatch --> A[Worker A]
    Dispatch --> B[Worker B]
    A --> Result[Persist task result and release slot]
    B --> Result
    Result --> Ready
    Result --> Review[Final review after all required branches]
```

## Planning contract

- Proposals contain `title`, `description`, `role`, `botId`, and optional
  `dependsOn` references to task IDs or titles. Role-only legacy proposals
  remain supported through deterministic Bot binding.
- `@everyone`, `@all`, and individual mentions constrain participation, not
  concurrency. Each requested active Bot must receive a task. Missing
  coverage or an unavailable explicit Bot blocks planning with a reason;
  the runtime does not invent extra work.
- Independent work has no mutual dependency. Real input dependencies and
  overlapping file writes must be described and ordered by the Coordinator.
  This change does not create worktrees or enforce filesystem isolation.
- An existing final review joins all terminal branches; a review gate is
  added for multi-task plans when necessary.

## Execution and receipts

Each task has its own adapter binding and detached conversation. Two tasks
with the same role cannot overwrite each other's execution identity. The same
Bot's turns are serialized, including across managed runs. A Bot waiting for
its previous turn can occupy an admitted slot; distributing independent work
across distinct Bots avoids that bottleneck.

The DAG shows waiting for dependencies, waiting for a slot, running, and
terminal states. Mentioned Bot assignments are listed separately, including
before planning finishes. Task ownership, output, conversation links, and
assignment events are persisted for later inspection.

Pause stops new worker execution. Cancellation stops workers and prevents
queued tasks from starting; a replacement run is rejected until the old run
drains. A failed task blocks its descendants while independent branches can
finish. Coordinated workers cannot use Roundtable `ask_bot` or `delegate_bot`
to create peer turns outside this scheduler; credential tools retain their
existing behavior. Provider-native internal subagents are outside this
Roundtable worker-task limit.

Existing concurrency settings are normalized to 2. Settings presets no longer
change concurrency; single-Bot channels have one effective slot.

## Verification

`server/coordination.test.ts` uses controlled completion gates against the
installed OMA scheduler to verify overlap, immediate slot refill, dependency
ordering and result handoff, a peak of two workers, same-role identity,
mention-all coverage and persistence, same-Bot serialization, failure, and
cancellation. `server/index.test.ts` verifies the peer-turn guard through the
real harness HTTP API with a fixture provider.

```text
pnpm exec vitest run server/coordination.test.ts server/config.test.ts src/lib/coordination-dag.test.ts
pnpm exec vitest run server/index.test.ts -t "prevents coordinated workers"
pnpm typecheck
```
