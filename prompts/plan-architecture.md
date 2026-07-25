---
description: Interactive architecture/planning session — resolve ambiguity via targeted questions, inspect repo impact, then emit a plan and durable ROADMAP.md
argument-hint: "[plan request]"
---

# Plan Architecture

> **OpenCode → Pi note (ported skill).** Term mapping for the body below:
> - OpenCode **question tool** → Pi has no separate tool; **ask the user the clarifying questions directly in your response**, grouped so the user can answer efficiently.
> - OpenCode **scout sub-agent** / **task tool** (`subagent_type: "scout"`) → Pi's builtin **`scout`** agent launched via the **`subagent(...)`** tool (or `/run`, `/parallel` slash commands).
> - **edit tool** → Pi's `edit`.
> - Where the text says "OpenCode session", read it as "a future session".

**Planning request:** ${ARGUMENTS:-<state what you want planned/architected — a feature, refactor, migration, design, or multi-step coding strategy, and its scope>}

## Goal

Produce complete, durable technical architecture plans only after resolving ambiguity with the user.

The final result must include both:

1. A complete implementation plan in the response.
2. A `ROADMAP.md` file that preserves exact user stipulations, decisions, decomposition, tests, milestones, behavior-change authorizations, conflict resolutions, and progress state so future sessions can continue from where the current session stopped.

## Core rule

Do not emit the final architecture plan immediately.

First use the question tool to ask a guided battery of questions that eliminates ambiguity in the user's request. Continue asking follow-up questions until the request is specific enough to plan safely.

Use the question tool rather than only asking in plain text. Group questions so the user can answer efficiently.

After every answered question-tool exchange, immediately edit `ROADMAP.md` before continuing analysis, asking another question, or preparing the final plan.

## Interactive session rule

Run this skill as a highly interactive planning session.

If analysis is getting long, the request is underspecified, the model is confused, or multiple plausible interpretations remain, stop trying to resolve the issue silently. Use the question tool to ask the user targeted clarifying questions instead of making the user wait while independently exploring uncertain paths.

Prefer asking a small, high-leverage question over making a brittle assumption.

Ask more questions when:

* The model cannot confidently identify the user's intended technical change, scope, constraints, or success criteria.
* The repo structure suggests multiple implementation paths.
* The correct testing strategy is unclear.
* The next decision would materially affect component boundaries, APIs, data models, file formats, performance, compatibility, or rollout.
* The model would need a long reasoning path to choose between alternatives.
* The user can likely answer faster than the model can infer.
* Repo impact analysis reveals possible conflicts or behavior changes.
* Existing behavior would need to change but no exact human authorization exists yet.

In some cases, even if you could answer a question alone, consider the following first:
* Would it require you multiple tool calls to answer this one question?
* Is it the type of question that a competent human could trivially answer?

If it is the case, ask the human instead in order to reduce turnaround time when planning. If the user can't answer it trivially, they'll just pass it back to you to then do your longer analysis, and if they can, we saved time.

## Architecture Contract

Treat the user's answers during the question phase as binding architecture contract material.

After every question-tool Q&A exchange, immediately edit `ROADMAP.md` directly and record the user's exact answers verbatim under this top-level heading:

```markdown
# Architecture Contract
```
For each Q&A batch, append a new entry using this format:

This rule exists to preserve the user's exact words if the session is auto-compacted, interrupted, or resumed by another session before planning is complete.

```markdown
## Q&A Session: YYYY-MM-DD HH:MM

Q: <paste model question here>
A: <paste human response here>

Q: <paste model question here>
A: <paste human response here>
```

Preserve the user's wording verbatim, including wording, terminology, caveats, and uncertainty.

If `ROADMAP.md` does not exist yet, create it immediately after the first answered Q&A session, even before the final plan is ready.

Never rely only on conversation memory for human stipulations once a Q&A answer has been received.

## Behavior Flow

When this skill is invoked, carry out the following actions in the following order:

### Setup Phase
Read `ROADMAP.md`.

Based on whether it exists, our behavior branches.

If `ROADMAP.md` exists, check whether the user's request corresponds to a roadmap element that is:
* Marked as airtight
* Not yet marked as completed.

If `ROADMAP.md` already has the user's request, and it is marked as airtight, summarize what the roadmap says is the plan, and then this skill is completed and the user can move on to implementation at their leisure.
If `ROADMAP.md` already has the user's request, but it isn't marked as airtight, then move to the Tightening Phase.

If `ROADMAP.md` doesn't have the user's request planned yet, or doesn't yet exist, move to the Architecting Phase.

During the process of carrying this out, do not read any other files besides `ROADMAP.md` to make your decision.

### Architecting Phase

During the Architecting Phase, use the question tool to flesh out the user's request.

Questions should focus on:
* How to break down the user's change into small, targeted changes, usually scoped to one or two files at most
* What API changes the user intends to make
* What behaviors do the user intentionally not want to change

During this phase, do not read any code around the repo unless it is necessary, as the ideal plan is to frontload all user-interaction-required tasks to the beginning, as all questions during this phase concern the user's intent and can be answered better by a user than by existing repo code.

Using this information, the break down the user's request into a loose, multi-step plan, and then write it to `ROADMAP.md`, with each step tagged as loose.

After the Architecting Phase is complete, move on to the Tightening Phase, where we will tighten the first step of the user's request in the plan. Other steps of the plan that were created this way are to be ignored until the user moves forward to them, as the plan should focus on small, incremental changes.

### Tightening Phase

During the Tightening Phase, pivot towards questioning the user about explicit technical details, centered around the following:
* What exact technical behavior should exist after the change.
* What ambiguity exists in the user's wording.
* What contradictions exist between requested behavior, repo behavior, and constraints.
* What existing behavior must be preserved.
* What existing behavior the user is explicitly willing to change.
* What files, symbols, APIs, commands, data structures, configuration keys, formats, or tests are likely implicated.
* What the smallest targeted implementation could be.
* What test evidence would prove the change works without drifting unrelated behavior.

Before the first round of questioning is complete, still do not read any code files, as this can consume too much context window unnecessarily. Obtaining correct information from the user for targeted read invocations is key to minimizing context wastage.

After collecting relevant information about the intended implementation from the user, use tools like `grep` to loosely scan the repo and determine what files or implementations the user's request may touch. If the user previously used plan mode to explore the structure and implementation of a repo, you may also use that information from earlier in the history for this purpose.

Once important key files have been identified, read their content, then cross-reference the source code with the plan step that we are currently implementing. If additional technical decisions appear, or there are contradictions between what the user wants to accomplish and existing implementation details/points, at this point, fire a second battery of questions to nail down these points. In particular, if a change would break preexisting behavior, ask the user to define the exact scope and limits of what they want their change to do, and what preexisting behavior explicitly needs to be preserved.

Search for relevant:
* Classes
* Functions
* Methods
* Types
* Interfaces
* API Routes
* CLI Commands
* Configuration Keys
* Error Strings
* Event Names
* Database Tables or Migrations
* Serialization Formats
* Public Schemas
* Tests and Fixtures
* Documentation Examples
* Callers and Downstream Consumers

During this phase, you should delegate up to two sub-agents to perform the cross-referencing operations in order to preserve your context window.

Repeat this process until the current plan step is air-tight, and then modify `ROADMAP.md` to mark it as airtight, and then this skill is completed.

Whenever the user explains an explicit impact or existing behavior that they want to change, mark it as such in the roadmap as a sub-bullet, and cite a specific Q&A session to justify it. Uncited changes should not be implemented.

For each finding, include:
* File or symbol.
* Why it is relevant
* Whether it must change or must not change
* Any related tests

Without these cited notes, the plan step **cannot be marked as air-tight.**

## Existing repo testing requirement

When building on an existing repo:

1. Detect the existing test framework and commands.

   * Inspect manifests such as `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `build.gradle`, `Gemfile`, or equivalent.
   * Inspect existing test directories and CI config.
   * Identify naming conventions, fixtures, mocks, snapshot patterns, golden files, property tests, integration-test style, and CI commands.

2. Design tests that integrate with the existing framework.

   * Do not propose an unrelated new test framework unless the repo has no viable test framework or the user asks for one.
   * Reuse existing helpers, fixtures, factories, mocks, test utilities, golden-file patterns, and command conventions.
   * Include exact test locations and commands when possible.

3. Make every increment testable.

   * Each major implementation step should have a corresponding unit, integration, regression, property, fixture, CLI, or acceptance test as appropriate to the repo.
   * Include a validation command for each milestone when possible.
   * Include behavior-preservation tests when touching existing behavior.
   * Include regression tests for any explicitly authorized behavior change.

## Final plan format

After the question phase, repo impact exploration, and conflict resolution are complete, produce a final response with:

1. Summary

   * One-paragraph explanation of the planned technical change.

2. Decisions

   * Key technical decisions and why they were chosen.
   * Cite exact Q&A sessions for human-driven decisions when relevant.

3. Assumptions

   * Only the assumptions that remain after questioning and repo inspection.
   * Do not list behavior-changing scope as an assumption.

4. Architecture

   * Components and their responsibilities.
   * Data flow or control flow.
   * Integration boundaries.
   * Error handling.
   * Security, privacy, performance, compatibility, and concurrency considerations when relevant.

5. Behavior change ledger

   * Existing behaviors preserved.
   * Existing behaviors changed.
   * For every changed behavior, cite the exact `Human-Defined Architecture Contract` Q&A session that authorized the change.
   * Tests that prove intended changes and protect unrelated behavior.

6. Incremental implementation plan

   * Ordered milestones.
   * Session-sized, patch-sized, or commit-sized tasks.
   * Files/modules likely to change.
   * Dependencies between tasks.
   * The behavior preservation or behavior change scope for each task.

7. Testing plan

   * Existing framework detected.
   * Tests to add or update.
   * Commands to run.
   * What each test proves.
   * Manual verification steps, if needed.
   * Behavior-preservation coverage.
   * Regression coverage for authorized changes.

8. Risk and compatibility plan

   * Risks and mitigations.
   * Backward compatibility notes.
   * Migration, compatibility layer, flags, or cleanup steps if needed.

9. ROADMAP.md status

   * State whether `ROADMAP.md` was created or updated.
   * Mention the path.
   * Mention the latest `Human-Defined Architecture Contract` Q&A session recorded.

## ROADMAP.md requirement

Create or update `ROADMAP.md` alongside the final plan and after every answered Q&A batch.

Location rules:

1. If inside a git worktree, place it at the repository root unless the user asks for a different location.
2. If not inside a git worktree, place it in the current working directory.
3. If a `ROADMAP.md` already exists, update it rather than replacing useful prior content.
4. Preserve completed work and prior decisions unless the user explicitly says to reset the roadmap.
5. Preserve `# Human-Defined Architecture Contract` verbatim entries exactly.

`ROADMAP.md` should **NEVER BE COMMITTED**, nor should details contained within be explicitly mentioned in a commit message (eg. No citing Q&A sessions in commit messages, mentioning whether implementation details are corroborated by the architecture contract, etc.). This is because `ROADMAP.md` is an internal planning document that PR reviewers should not need to see or deal with.

## ROADMAP.md template

Use this structure:

```markdown
# Architecture Contract

This section preserves the user's exact answers from architecture Q&A sessions. These answers are binding stipulations and must be read before asking more questions, resuming work after compaction, or producing an architecture plan.

## Q&A Session: YYYY-MM-DD HH:MM

## Behavior Invariants

Record what should not be built or changed.

## Architecture Overview

Describe the selected technical architecture, major components, and integration boundaries.

# Roadmap
- [ ] Roadmap items in bullet-pointed list form, using Markdown checkbox formatting
   - [ ] Airtight?
   - Other details / things this will change / authorized updates to existing behavior with a citation
```

Citation format should list the `YYYY-MM-DD HH:MM` of the referenced Q&A session and a small note about why this session authorizes this change.

## Sub-agent delegation rule

Use sub-agents for repo cross-referencing, impact analysis, test-framework detection, and implementation fact gathering when doing so would otherwise consume the parent session's context.

For this task, since sub-agents are intended to inspect source code and answer questions for the parent model, the `scout` sub-agent should always be used. The general sub-agent, which has lesser context, should be avoided.

The parent session owns:

- `ROADMAP.md`
- `# Architecture Contract`
- Q&A with the user
- phase transitions
- behavior-change authorization
- final planning decisions

Sub-agents may inspect source code, tests, docs, call sites, and manifests, but they must return bounded factual reports only.

Sub-agents must not:

- Ask the user questions.
- Decide user intent.
- Authorize behavior changes.
- Mark roadmap items airtight.
- Produce the final architecture plan.
- Read broadly beyond their assigned scope.
- Return large code excerpts.

Sub-agent reports must be concise and structured:

```markdown
# Sub-Agent Report: <topic>

## Assigned question

## Commands/searches performed

## Relevant files/symbols

## Existing behavior found

## Potential conflicts

## Tests found

## Unknowns
```
