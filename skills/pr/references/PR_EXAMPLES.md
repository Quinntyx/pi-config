# PR Writing — Worked Examples

Real before/after pairs from pylingual PRs. "Before" = mechanism-first draft.
"After" = the revised, reviewed version. The rules in `SKILL.md` are distilled
from these.

---

## Style base — PR #144 (the original)

```
Title: Inline generics on 3.12+ (instead of 3.14+)

This PR splits `inline_annotate_function` into two functions. Previously,
inlining both annotate and generic type parameters was handled by
`inline_annotate_functions`, which only ran on 3.14+, but inlining generic type
parameters is needed on 3.12+ (PEP 695).

The solution is to split `inline_annotate_functions` into two functions, and
gate inlining generics on 3.12+ while inline_annotate is gated on 3.14+.

This is semantically equivalent on 3.14+, but on 3.12+ eliminates PEP 695-related
errors.

However, we need model retraining to see how much better it will actually be
```

Structure: problem → solution → semantic equivalence → caveat / future work.
Note the closing caveat is a signature element.

---

## Example 1 — decompiler fixes

**Before:**
```
Fix control flow reconstruction indexing errors

This PR fixes two indexing errors in the decompiler's control flow
reconstruction that surface when the model produces fewer lines than expected.
... Both are robustness fixes with no behavioral change on well-formed output.
```

**After:**
```
Fix control flow reconstruction IndexErrors

Currently, the `cft` layer indexes `source_lines` using segmentation 'B'
boundary entities, but the statement model is not guaranteed to return the same
number of source lines as boundaries. This causes misalignment leading to
Different Control Flow errors and occasionally IndexErrors.

This PR fixes two indexing errors in the decompiler's control flow
reconstruction that surface when the model produces fewer lines than expected
by adding padding strings. This stops IndexErrors in the decompiler but doesn't
actually solve misalignment--there's an implicit assumption that as long as the
decompiler doesn't crash, issues like this can be caught by the perfect
decompilation retrying system, which in my testing was mostly true but may be
something to look at later if we're trying to chase down Different Control Flow
issues.

Separately, `equivalence_results` can be longer than `ordered_bytecodes`, so the
equivalence check and reconstruction indexes fell out of sync. The indexing
between the two is now reconciled.
```

What changed:
- Title names the symptom: `IndexErrors` (domain term), not "indexing errors"
- Opens with root cause and the actual observed error class ("Different Control Flow errors")
- States the limitation explicitly: "doesn't actually solve misalignment" + the implicit assumption + testing evidence ("in my testing was mostly true") + future work ("may be something to look at later")
- Dropped the unverified "no behavioral change on well-formed output" claim

---

## Example 2 — dataset CSV hardening

**Before** ended with:
```
These changes are one coupled unit — the resume and stall-reporting code builds
on the retry/timeout machinery — so I've kept them in a single PR rather than
splitting them.
```

and claimed:
```
`signal.alarm` interrupted C extension calls (marshal.loads, xdis) mid-operation,
causing heap corruption and "double free or corruption" errors.
```

**After** removed the coupling paragraph entirely and hedged causality:
```
- Timeouts: `signal.alarm` occasionally interrupted C extension calls
  (marshal.loads, xdis) mid-operation, which could cause heap corruption and
  double free errors. This PR replaces them with a pool-level 300s timeout.
```

What changed:
- PR-process meta-commentary (why it's one PR) cut
- "interrupted … causing" → "occasionally interrupted … which could cause" (calibrated certainty)

---

## Example 3 — masking fix

**Before:** "...so cellvars and freevars now mask consistently."

**After:** "...so consistency of cellvars and freevars masking is improved."

What changed: absolute claim → measured claim. Same mechanism, hedged result.

---

## Example 4 — training fixes

**Before** (mechanism-first):
```
Two fixes for the model training scripts.

Segmentation training now uses local artifacts throughout instead of fetching
from the hub. The tokenizer is loaded from a local JSON path when present
(falling back to hf_hub_download), and tokenized datasets are saved to disk
locally instead of only being pushed to the hub — the upload still happens, but
a failure no longer loses the run. ...
```

**After** (problem-first, intent-driven, covers the whole diff):
```
Training fixes: local artifacts and Transformers 5 compat

The model training script is rather brittle and breaks when HF hub is
unavailable or we are out of storage space.

Segmentation training now prioritizes local artifacts. It still tries to upload
to hub, but rather than wasting time redownloading after upload succeeds, it
just proceeds even if hub upload fails and the hub upload can be fixed and
re-attempted later (better for unattended training runs, less chance of failing
and not actually doing the training).

Tokenized datasets are also saved to disk locally instead of only being
uploaded to the HF Hub, so local failures are more recoverable.

The statement trainer is updated for Transformers 5: `tokenizer=` is passed as
`processing_class=`, and `LOCAL_RANK` is read with a default so the rank-0
guard doesn't crash when the env var is unset.

`check=True` also added to subprocess `uv` invocations, so that if a particular
training stage fails, it will stop the pipeline instead of wasting compute on
trying to do later steps and being silently messed up.
```

What changed:
- Opens with the failure mode ("rather brittle and breaks when HF hub is unavailable or we are out of storage space") — context not visible in the diff
- Mechanism reframed around intent ("better for unattended training runs")
- `check=True` enumerated — a behavior change absent from commit messages, found only by scanning the diff
