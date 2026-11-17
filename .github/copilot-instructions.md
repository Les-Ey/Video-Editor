# Workspace Instructions — SpliceWright & SpliceWright Studio

## Spelling & Branding Rule
- Always use **`SpliceWright`** (with **`Wright`**, never `Write`) for the companion desktop video editor app and **`SpliceWright Studio`** for the VS Code extension.
- Whenever the user types `SpliceWrite` or `SpliceWrite Studio` in prompts, notes, or files, treat it as a typo for **`SpliceWright`** / **`SpliceWright Studio`** and automatically correct it without needing to ask.

## "What's Changed" Tracking Rule (`WHATS-CHANGED.md`)
- Maintain [`WHATS-CHANGED.md`](../WHATS-CHANGED.md) at the repository root.
- **When new features or fixes are added:** Always update `WHATS-CHANGED.md` under the **Pending Changes (Since Last Push)** section to summarize the newly added features or behavior changes.
- **After a `git push`:** Refresh `WHATS-CHANGED.md` by clearing/moving the pushed items out of **Pending Changes (Since Last Push)** into **Recently Pushed** (recording the commit/release) so the pending list starts fresh for the next set of changes.

