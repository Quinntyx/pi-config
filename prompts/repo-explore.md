---
description: Inspect a real upstream repository (cached at ~/.cache/repo_cache) before answering how a library/tool/framework/CLI/SDK/API works or how to patch it
argument-hint: "<repo or question>"
---

# Repo Explore

> **OpenCode → Pi note (ported skill).** The body uses standard tools (`rg`, `git grep`, `find`, `grep`) which work as-is in Pi via the `bash` tool. The report-output path conventions below are unchanged from the source skill.

**Target repository / question:** ${ARGUMENTS:-<repo URL, owner/repo, package/library/tool name, or the question you want answered>}

## Purpose

Use the implementation as the source of truth before answering questions about codebases that are not already present in the active project or conversation context. Prefer local source inspection over memory, package summaries, or documentation-only answers.

## Mandatory repo-cache check

Before answering, run this command exactly:

```bash
mkdir ~/.cache/repo_cache && ls ~/.cache/repo_cache
```

If the command fails because `~/.cache/repo_cache` already exists, immediately run:

```bash
ls ~/.cache/repo_cache
```

Use the listing to decide whether the relevant repository is already cloned.

## Repository resolution

1. Identify the target repository from the user's request.
   - If the user gives a Git URL, GitHub/GitLab URL, owner/repo pair, package homepage, or current project reference, use that.
   - If the user only gives a library, tool, or app name, resolve the canonical upstream repository before cloning. Use package metadata, an existing lockfile, registry metadata, or web search when available.
   - If multiple plausible repositories exist and the request is ambiguous, prefer the one connected to the package/import/CLI name in the user's request. Ask a clarifying question only when proceeding would likely inspect the wrong project.

2. Map the repository to a stable cache directory under `~/.cache/repo_cache`.
   - Prefer a readable directory name such as `github.com-owner-repo`, `gitlab.com-owner-repo`, or the exact existing cached directory if present.
   - Do not clone into the active project unless the user explicitly asks.

3. If the repository is already cloned in `~/.cache/repo_cache`, inspect that checkout before responding.
   - Use the cached implementation as the first source of evidence.
   - Do not update, reset, clean, or otherwise mutate an existing cached checkout unless the user asks for freshness or the checkout is unusable.

4. If the repository is not already cloned, clone it into `~/.cache/repo_cache` and then inspect the implementation before responding.
   - Use a shallow clone by default:

     ```bash
     git clone --depth 1 <repo-url> ~/.cache/repo_cache/<cache-dir>
     ```

   - If the repository requires submodules for the requested question, initialize only the necessary submodules.
   - If cloning fails, report the failure and answer only as far as the available evidence supports.

## Implementation inspection workflow

After selecting the cached repository, inspect the relevant implementation before producing the final answer.

Recommended sequence:

1. Read project metadata first: `README*`, package manifests, module manifests, CLI entrypoints, and source layout.
2. Locate relevant code with `rg`, `git grep`, `find`, `grep`, package manifests, import paths, command names, class names, function names, route names, config keys, or error strings from the user's question.
3. Open the most relevant files and trace behavior through callers/callees until the requested behavior is clear.
4. Prefer implementation files, tests, and examples over marketing documentation.
5. If documentation conflicts with code, state that the implementation appears to differ and explain the evidence.
6. Include filenames, functions, classes, commands, or config keys in the answer when they are relevant.

## Safety and hygiene

- Treat cached repositories as third-party code. Do not execute project scripts, install dependencies, run build steps, or run tests unless necessary for the user's request.
- Do not run destructive commands such as `rm -rf`, `git clean`, `git reset --hard`, force pushes, credential helpers, or commands that alter global configuration.
- Do not use private credentials or clone private repositories unless the user explicitly provides access and asks for that repository.
- Do not paste secrets found in cached repositories. If a secret-like value appears, mention only that a secret-like value exists and where it was found if relevant.
- Do not modify cached source unless the user explicitly asks for a patch or local experiment.

## Answer contract

Every answer produced after this skill is used should make clear whether the implementation was inspected.

When successful, include:

- The cached repository path inspected.
- The key files or symbols used as evidence.
- A direct answer grounded in the implementation.

When unsuccessful, include:

- Whether the repo-cache check was completed.
- Whether cloning or repository resolution failed.
- What evidence was available instead.
- Any uncertainty caused by not having the implementation.
