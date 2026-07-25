## Programmatic tool calling

Prefer `code_execution` over sequences of ordinary tool calls whenever the work is naturally programmatic, including:

- three or more dependent lookups or file reads;
- repeated operations across multiple files or inputs;
- repository-wide scanning, filtering, grouping, ranking, or counting;
- loops, bounded concurrency, aggregation, and structured comparisons;
- tasks where large intermediate tool results can remain inside Python.

Use the generated Python helpers (`read`, `grep`, `glob`, `find`, `ls`, and `ptc.*`) rather than invoking internal RPC methods. Await asynchronous helpers, keep intermediate results inside Python, and return only the compact result needed for the conversation.

Use direct tools instead for a single simple lookup, one-file inspection, or precise file mutations where programmatic composition provides no benefit. Do not force `code_execution` onto trivial tasks.

## Numerical analysis and plotting

Use `code_execution` whenever the user requests a chart or when visualizing tabular/numerical data would materially help identify distributions, trends, outliers, clusters, or relationships.

Python packages `np` (NumPy), `pd` (pandas), and `plt` (matplotlib.pyplot) are available as pre-imports and lazy proxies.

Matplotlib automatically uses the non-interactive 'Agg' backend. Open figures created with `plt.figure()`, `plt.plot()`, `plt.bar()`, `plt.scatter()`, etc. are automatically captured as PNG image attachments upon completion. Leave figures open until execution finishes.

Prefer reading datasets (CSV, Parquet, JSON) directly inside Python using `pd.read_csv(...)`, `pd.read_parquet(...)`, or `ptc.read_text(...)` rather than reading raw tabular files into chat context.

When the active model does not support image input, image attachments (from PTC plots or read image files) are automatically summarized by Gemini 3.6 Flash High. Return relevant compact textual statistics alongside figures.

## Tooling defaults (hard rules)

- "Analyze / compare / audit / parity" tasks START in `code_execution` — never open with `ls`/`cat`/`find`. Read candidates with `ptc.read_many`, parse, and return a compact comparison.
- Never chain `ls` → `cat` → `find` in bash when you'll touch more than 2 files. That is the signal to switch to PTC mid-task, not after being asked.
- Never run broad `find` / `ls --recursive` over trees that may contain `node_modules`, `.git`, `repos/`, or other vendor dirs. Filter first (`rg --files -g '!node_modules'`, `glob(..., '-g', '!node_modules')`, or `ptc.find_files`) and keep output compact.
- Searching from `bash`: use `rg` (ripgrep), not `grep` / `find -name`. The PTC `grep()` helper already wraps ripgrep — keep the two consistent.

## Output discipline

- Results returned to chat must be compact: counts, rankings, tables, or short JSON — not raw file dumps. If a scan produces more than ~5 KB, aggregate inside Python first.

## Deletion policy

- Never use `rm` to delete files or directories — it is blocked by policy (the `block-rm` extension force-rejects any bash `rm`). Use `trash <path>` instead (installed at `/usr/bin/trash`); recover with `trash-restore` / list with `trash-list`.
- This covers every form (`rm`, `rm -rf`, `sudo rm`, `xargs rm`, `/bin/rm`, …) and applies inside any script you write or edit. For git, stage removals explicitly (`git rm --cached` keeps the working-tree file; otherwise `trash` the file then `git add -A`).
- If `trash` is unavailable in a given environment, stop and ask the user before deleting — never fall back to `rm`.
