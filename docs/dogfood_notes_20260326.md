# Dogfood Notes

20260326

See "./interaction-modes.md" for context on the following discussion.

First, we should add a "Plan" mode, which is distinct from "Discuss" and "Do" in that there is the objective of spawning sub-tasks.

Next, as a developer using Harness, it's often that I might start with a discussion with the agent. This might end there for purely exploratory questions like "What does X do?" But just as often, the discussion is a prelude to defining one or a set of "Do" tasks. As such, a common next step is to transition to "Plan" or "Do" modes. However such a transition is currently now possible with Harness.

On a separate note, there are many tasks that bounce between the inbox and the outbox, such as reviewing of subtasks, granting permissions, revising of a task, fixing merge conflicts, following up on a completed task etc. At the moment, the handling of the task content feels inconsistent. In some cases, the original prompt is kept, but not in other cases. In general, the following should be preserved across the inbox/outbox bouncing:

- Original title and prompt
- Agent session history as seen by the user in the UI
- The actual agent session (so that the agent actually has continuous context)
- Files changed

In addition, these details should also be visible even after a task is completed. Currently, users can't see all the details of completed (or rejected) tasks - agent session history is not visible (you can only see the agent summary) and the actual file changes are not visible as well (you can only see the diff summary).

Finally, as a small nit, the agent live session should have tool call details and results as collapsible elements, so that we don't get overwhelmed.
