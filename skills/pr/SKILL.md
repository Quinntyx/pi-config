---
name: pr
description: Writes pull request titles and bodies in a problem-first, engineer-to-engineer style. Use when opening or drafting a PR, revising an existing PR description, or asked to "write a PR", "make a PR", or split work into PRs. Distills diffs and commit history into a concise body that leads with the real failure mode, states the mechanism, explicitly calls out limitations and assumptions, hedges unverified claims, and uses the repo's own error vocabulary.
disable-model-invocation: true
---

# Pull Request Writing

## Style (why this skill exists)

The default instinct is to write polished release notes: mechanism, then a claim. This skill produces engineering notes *to other engineers*, calibrated to what is actually verified. The signature style is the style base: problem → solution → semantic equivalence → caveat / future work, with an explicit "what this fix does NOT do" section.

## Workflow

1. **Collect the failure story first.** The operational context (e.g. "breaks when HF hub is unavailable", "hit while generating on NAS-backed storage") is rarely in the diff — it's in the author's head. If the diff or commit messages don't state it, ask: *What failure mode does this fix? What happened in practice?*
2. **Scan the FULL diff, not just commit messages.** Commit messages omit behavior changes. Look for things like `check=True`, `push_to_hub=False`, removed `overwrite_output_dir`, signature changes, and enumerate them in the body.
3. **Probe the repo's own vocabulary.** Grep for the error names and system terms the codebase actually uses (e.g. "Different Control Flow errors", "perfect decompilation retrying system", "equivalence_results"). Use those exact terms; do not paraphrase into generic wording.
4. **Draft problem-first.** One opening line on the real-world failure mode, then the mechanism, then what the fix does and does not accomplish.
5. **Write the limitations section honestly.** If the fix is a stopgap or rests on an implicit assumption (e.g. "padding prevents the crash but does not solve misalignment; it relies on the retry system catching it"), say so, with testing evidence if available ("in my testing was mostly true").
6. **Calibrate certainty.** If a claim is not verified, hedge it ("occasionally", "could", "mostly") or drop it. Never assert "no behavioral change" unless proven.
7. **No PR-process meta-commentary.** The body describes the change; it does not justify why the PR is shaped the way it is (no "kept in one PR because…" paragraphs).
8. **Self-review with the checklist below** before submitting.

## Title

Plain, descriptive sentence. No `feat:`/`fix:` prefixes. Name the concrete symptom or result, optionally with version/scope context.

- Good: `Inline generics on 3.12+ (instead of 3.14+)`
- Good: `Fix control flow reconstruction IndexErrors`
- Good: `Avoid rebuilding stripped bytecode for masking`
- Avoid: `Fix two indexing errors in the decompiler's control flow reconstruction that surface when the model produces fewer lines than expected` (too long) — but a title that names the symptom (`IndexErrors`) beats a vague one.

## Body template

```markdown
<One line on the real-world failure mode: what breaks, when, and why it matters.
 If the diff doesn't show it, get it from the author.>

<What the PR does — the mechanism. Name the actual functions/systems using the
 repo's own terms.>

<Explicitly: what the fix does NOT do, what assumption it rests on, and what
 should be looked at later, with hedged, evidence-backed certainty.>

<If applicable: separate concerns get their own short paragraphs.>
```

Keep it short. Two to four short paragraphs; bullets only when there are genuinely parallel items (e.g. a multi-part hardening change).

## Checklist (self-review before submitting)

- [ ] Opens with the failure mode / motivation, not the mechanism
- [ ] Uses the repo's own error/system vocabulary (grepped, not paraphrased)
- [ ] Has an explicit limitations / assumptions statement where the fix is partial or rests on a heuristic
- [ ] Unverified claims are hedged or removed — no "no behavioral change", no absolute "now correct", no unqualified causality
- [ ] Full diff scanned: every behavior change (flags, defaults, control flow) is accounted for
- [ ] No PR-process meta-commentary (no "so I kept them in one PR")
- [ ] Title is a plain descriptive sentence naming the symptom
- [ ] Concise: 2–4 short paragraphs, bullets only for parallel items

## Worked examples

See [references/PR_EXAMPLES.md](references/PR_EXAMPLES.md) for before/after pairs from real PRs: the style base (#144), and the four revised drafts that this skill's rules are distilled from.
