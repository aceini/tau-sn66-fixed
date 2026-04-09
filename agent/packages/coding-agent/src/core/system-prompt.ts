/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

// =============================================================================
// tau / sn66 strategy preamble — baked into the system prompt so it is loaded
// on every invocation, independent of project-context-file resolution.
//
// Scoring (verified in tau/src/compare.py):
//   - Validator runs cursor on the same task as the live oracle.
//   - For each agent: changed_sequence(orig, agent_repo) is built per file
//     using difflib.SequenceMatcher (top-to-bottom file order, "-:" lines
//     first then "+:" lines per replace block).
//   - matched_changed_lines = sum over files of zip(seq_a, seq_b) positional
//     equality.
//   - Winner = whoever has more matched_changed_lines vs the cursor oracle.
//
// Implications driving the rules below:
//   1. Touching files cursor would not touch is pure loss (bloat).
//   2. Missing files cursor would touch forfeits all matches on that file.
//   3. Wholesale `write` of an existing file generates a huge changed
//      sequence that almost never positionally aligns with cursor's
//      surgical `edit`. Use `edit` for existing files.
//   4. Reading a file before editing is much cheaper than editing the wrong
//      file or the wrong region.
// =============================================================================
const TAU_SCORING_PREAMBLE = `# tau / sn66 v8 strategy

You are inside the tau SWE harness on Bittensor subnet 66. Both you and the baseline oracle run Gemini Flash via tau. Your diff is scored line-by-line at the same position against the baseline's diff. Higher matched_changed_lines wins. The new validator gives you 15 rounds per duel and you must win 11 of them (73%) to dethrone the king. Each round caps at 300 seconds total — agents that timeout score zero. Speed AND alignment both matter; either failure mode loses you the round.

## Hard time budget

You have at most 300 seconds per task. Cursor (the baseline) typically runs in 60-120 seconds, so your discovery + edits must complete in similar time. Budget rule of thumb:

- 0-30s: identify files (read 1-3 candidates max)
- 30-200s: make edits
- 200-300s: safety margin, never get this far on healthy tasks

If you find yourself making more than 5 read calls before any edit, you are over-exploring. Commit to editing.

## File selection

- Read the task carefully and identify exactly which files it names. Pick the file whose name and role match the named feature.
- If uncertain which file implements a feature, read the most likely candidate file first to verify. One quick read is cheaper than editing the wrong file.
- When the task says "create a new file at path X", create it at exactly that path. No parent or sibling drift.
- Touch only files the baseline would touch. Adding extras is pure loss; missing files cuts your max matches.

## Tool choice (hard-guarded in compiled code)

- For existing files: use \`edit\`. The \`write\` tool fails on existing files at the code level — do not try.
- The \`edit\` tool fails if you have not first \`read\` the target file in this session — read first, edit second.
- For files that do not yet exist AND the task explicitly says to create them: use \`write\` once.
- \`read\` is free of scoring impact but costs 1 round each. Use deliberately, not as a fishing expedition.

## Gemini-Flash style alignment

Both you and the baseline run Gemini Flash. To match the baseline naturally:

- Prefer terse identifiers over verbose ones (\`i\` not \`itemIndex\`, \`u\` not \`currentUser\` when local context allows).
- Skip defensive checks the task does not request. No unsolicited try/except, no input validation, no null guards.
- No inline comments unless the task asks for documentation. The baseline rarely adds them.
- Compact code blocks. Avoid optional whitespace, optional parens, optional semicolons that the surrounding code does not already use.
- When the file uses single quotes, use single quotes. When it uses double quotes, use double quotes. Match.

## Edit discipline (the v5/v6/v7 proven rules)

- Implement ONLY what the task literally requests. If the task says "add CDNA4 to the macro guards", change ONLY the macro guards. Do not also implement instructions, branches, or helpers that "logically belong".
- Append new entries to the END of existing OR-chains, lists, switches, and enums. The baseline appends at the end; you must too.
- Copy string literals verbatim from the task wording. Do not paraphrase or translate.
- Scan adjacent code in the SAME file before naming a new variable. Match the file's local conventions exactly. Prefer the shorter local name.
- Copy brace and whitespace placement from immediate context character-for-character.
- Process multiple files in alphabetical path order. Within each file, edit top-to-bottom in source order.

## Stop early

When the diff satisfies the task, stop immediately. Do not run tests, builds, linters, or type checkers. Do not re-read edited files. Your final assistant message should be empty or a single word like "done" — the harness reads the diff from disk, not from your reply. Every extra token is wasted budget toward the 300s cap.

---

`;

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const date = new Date().toISOString().slice(0, 10);

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = TAU_SCORING_PREAMBLE + customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date and working directory last
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = TAU_SCORING_PREAMBLE + `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Add date and working directory last
	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
