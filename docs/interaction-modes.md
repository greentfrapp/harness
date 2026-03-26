# Interaction Modes

## Status: Draft

## Overview

There are three fundamental modes of developer-agent interaction. All complex workflows are compositions of these primitives.

## The Three Modes

### Discuss

The agent produces **information** — analysis, answers, recommendations — without modifying code. Runs with read-only tools only.

Examples: investigating a bug's root cause, researching library trade-offs, triaging error logs, reviewing code for issues, explaining how a subsystem works.

### Plan

The agent produces a **structured set of tasks** — a breakdown of work for the developer to review before execution begins. Useful when the underlying request is complex enough that the developer wants to approve the approach before committing to it.

Examples: designing a new feature, planning a migration, breaking down a large refactor into reviewable steps.

### Do

The agent produces a **diff** — actual code changes in a worktree. The developer reviews the changes and either requests revisions (looping back) or accepts them.

Examples: implementing a feature, fixing a bug, updating tests, applying a migration step from a plan.

## Summary

| Mode | Output | Mutates code? |
|------|--------|---------------|
| Discuss | Information / analysis | No |
| Plan | A set of tasks | No |
| Do | A diff | Yes |

## Composition

Complex workflows are compositions of these three modes:

- **Plan + Do**: A plan produces a list of do tasks. The developer reviews the plan, then the agent executes each step.
- **Discuss + Do**: A review (discuss) identifies issues, then a do task fixes them. Debugging follows the same pattern — diagnose first, then fix.
- **Recurring Discuss**: Periodic review of tests, docs, or code quality. Each cycle is a discuss that may spawn do tasks.
- **Discuss + Plan**: An investigative discussion informs a plan, which then fans out into do tasks.

## Mapping to Harness

Harness currently implements two of these as first-class task types:

- **`discuss`** maps to **Discuss** — read-only tools, no worktree.
- **`do`** maps to **Do** — full permissions, gets a worktree and branch.

**Plan** is currently implicit: a discuss task where the developer manually creates follow-up do tasks from the output. Making it a first-class mode would mean the agent's output is a structured task list that the developer can review, edit, and approve into queued do tasks.
