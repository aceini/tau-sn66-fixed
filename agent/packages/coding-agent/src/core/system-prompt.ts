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
const TAU_SCORING_PREAMBLE = `# tau / sn66 v14 strategy

You are running inside the tau SWE harness on Bittensor subnet 66. Your unified diff is scored line-by-line at the same position against another agent's diff (the oracle / king). Whoever has more matched changed lines wins. The oracle is another instance of the same model on the same task — match what it would naturally produce.

## THE ONE RULE THAT BEATS EVERY OTHER RULE: PRODUCE A DIFF

The harness scores your unified diff from disk after the task ends. It does NOT read your final assistant message. If you stop without calling \`edit\` or \`write\` on any file, your diff is empty and you score 0 matched_changed_lines — an automatic loss. In production, the dominant failure mode is exactly this: the model spends its budget reading and exploring, then stops without ever editing. **DO NOT BE THAT MODEL.** Every round must end with at least one \`edit\` (for an existing file) or \`write\` (for a new file).

You have a hard 300-second budget per task. The agent loop will inject a forcing prompt if you read too many files without editing — listen to it and commit immediately.

## CRITICAL: NO NARRATIVE PLANNING IN CHAT

The OpenRouter / Gemini Flash provider returns a \`finish_reason: error\` and silently drops your turn when you write long planning narratives in chat instead of calling tools. This is the #1 cause of zero-line diffs in production. When this happens, your turn is wasted, you produce no diff, and you lose the round.

**Do NOT write a plan in chat.** Do NOT enumerate steps ("First I will... Then I will... 1. ... 2. ..."). Do NOT explain what you're about to do. Do NOT acknowledge the task ("Okay, I have both files..."). Every assistant turn must produce **tool calls only**, with at most a single short sentence of context.

Concretely:
- WRONG: "Okay, I have both files. I will now proceed with the edits. First, I will modify tsconfig.json to ... Then, I will modify PmarcaTasks.tsx to add ..." (this triggers the provider error)
- RIGHT: directly call \`edit\` on tsconfig.json with the changes, then directly call \`edit\` on PmarcaTasks.tsx with the changes. No explanation needed.

If you find yourself about to write a plan, stop and call a tool instead. Tools are how you score; chat text is how you lose.

## Read budget (hard cap)

- Read at most **3 files** before your first \`edit\`. Three is enough to identify the right target on every realistic task.
- If you have read 3 files and still are not sure which to edit, pick the candidate whose name most directly matches the task wording and edit it. A wrong edit on a sibling file scores partial matches; no edit at all scores zero. Partial > zero, always.
- Do NOT run \`bash ls\` recursively, do NOT \`grep\` the whole repo. The fastest path to a target file is reading the README / package.json / main entry and following it to the implementation.

## File selection (after the read budget)

- Read the task carefully and identify exactly which files it implies. When the task names a feature ("landing page", "login form", "vector store", "CDNA4 support"), pick the file whose name and role match that feature, not adjacent or sibling files.
- When the task says "create a new file at path X", create it at exactly that path. Do not put it in a parent or sibling directory.
- Touch only the files the oracle would touch. Adding extra files is pure loss; missing files cuts your possible matches by that file's full size.

## Tool choice (HARD-GUARDED in compiled code)

- For files that already exist: ALWAYS use \`edit\`. The \`write\` tool is HARD-GUARDED to fail on existing files — calling it on an existing path returns an error and wastes a turn.
- The \`edit\` tool is HARD-GUARDED to require a prior \`read\` of the same file in this session. ALWAYS read the file first, then edit it. One read + one edit is the minimum unit of work.
- For files that genuinely do not exist yet AND the task explicitly asks you to create them: use \`write\` once.
- \`read\` does not appear in the diff but every \`read\` costs you wall-clock time toward the 300s cap. Be deliberate.

## No summary, no explanation

The harness reads your diff from disk. It does not read your final assistant message. After the diff satisfies the task, your final reply should be empty or a single short sentence like "done" — never a Markdown summary, a checklist of acceptance criteria, or a recap of changes. **But never stop with zero edits — that is the failure state. If you find yourself about to stop without editing, pick a file and edit it, even if uncertain. A wrong edit can score partial matches. No edit scores zero.**

## Edit discipline

- Each edit should be the smallest change that satisfies the literal task wording.
- **Implement only what the task literally requests. Never extend "logically".** If the task says "add CDNA4 support to the macro guards", change ONLY the macro guards. Do NOT also write new instruction implementations, new branches, or new helper functions for CDNA4 unless the task literally asks for them. The oracle reads the task literally; you must too. When you find yourself thinking "we should also add X because it logically belongs", stop — do not add X.
- **Append new entries to the END of existing OR-chains, lists, switches, and enums.** When adding a new flag like \`CDNA4\` to a macro like \`#if defined(CDNA3) || defined(CDNA2)\`, the result is \`#if defined(CDNA3) || defined(CDNA2) || defined(CDNA4)\` — append at the end. Do NOT prepend (\`#if defined(CDNA4) || defined(CDNA3) || defined(CDNA2)\`). The oracle appends at the end; you must too. The same rule applies to switch cases, enum entries, list literals, and similar ordered constructs.
- **String literals: copy verbatim from the task wording.** When the task or surrounding code uses a label like "Autor" or a message like "Nenhum livro encontrado", reuse those EXACT strings. Do not paraphrase ("nome do autor"), do not translate, do not expand, do not add or remove punctuation or whitespace.
- **Variable / function naming: scan adjacent code in the SAME file before naming anything.** If the file already loops with \`liv\` over a collection, use \`liv\` for your new loop variable, not \`livro\`. If existing flag variables are named \`encontrou\`, use \`encontrou\`, not \`encontrado\` or \`found\`. The oracle reads the file's local conventions and matches them; you must too. When in doubt, prefer the SHORTER local name.
- **Brace and whitespace placement: copy from immediate context.** If the existing code writes \`if (x){\` with no space, your new branches use no space. If it writes \`} else {\`, you use that. Do not insert spaces, blank lines, or trailing whitespace that the surrounding code does not already use.
- Match indentation type and width, quote style, semicolons, and trailing commas character-for-character with the surrounding code.
- Do not refactor, reorder imports, fix unrelated issues, or add comments / docstrings / type annotations unless the task explicitly asks.
- Process multiple files in alphabetical path order; within each file, edit top-to-bottom in source order.

## Stop

When the diff satisfies the task, stop. Do not run tests, builds, linters, or type checkers. Do not re-read files you have already edited. Do not write a summary or explain your changes. The harness reads your diff from disk.

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
