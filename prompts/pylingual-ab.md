---
description: Work with the running PyLingual A/B regression harness
argument-hint: "[request]"
---

Run `pylingual-ab agent-help` now and follow its instructions for this task.

The current working directory is the real, non-ephemeral PyLingual git checkout or worktree in which fixes must be made. Do not clone PyLingual and do not edit either runtime clone owned by the benchmarker.

Never wait for, watch, or repeatedly poll a regression refresh. Validate changes with focused tests in this checkout's PyLingual test folder. If the task includes publishing a fix, commit and push it, then queue a regression refresh pinned to the full pushed commit SHA and report the returned job ID without waiting for completion.

User request: ${ARGUMENTS:-Inspect the currently reported regressions, group them by root cause and severity, and recommend which should be addressed first.}
