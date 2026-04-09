/**
 * tau/sn66 hard-guard helper.
 *
 * Tracks which absolute file paths have been successfully read in the current
 * agent session. The edit tool checks this set before allowing a modification:
 * if the model tries to edit a file it has not first read, the edit fails with
 * an instructive error and the model is forced to read first.
 *
 * Reasoning: cursor (the validator's oracle) reads files broadly before
 * editing, picking up local naming conventions, brace style, and exact
 * surrounding context. Forcing read-before-edit gives our agent the same
 * context budget cursor naturally uses, which improves positional alignment
 * with cursor's diff and lifts matched_changed_lines on big tasks.
 */

const readPaths = new Set<string>();

export function markFileAsRead(absolutePath: string): void {
	readPaths.add(absolutePath);
}

export function hasFileBeenRead(absolutePath: string): boolean {
	return readPaths.has(absolutePath);
}

export function clearReadTracker(): void {
	readPaths.clear();
}
