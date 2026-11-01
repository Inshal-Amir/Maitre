/** Skills that ship with Maitre. A user skill with the same name replaces one of these. */
export interface BuiltinSkill {
  name: string;
  description: string;
  instructions: string;
}

const SKILL_CREATOR = `# Creating a skill

A skill is a folder with a SKILL.md file: YAML frontmatter (\`name\`, \`description\`) and Markdown instructions. Maitre lists every skill's name and description to the agent, and loads the full instructions only when a task matches, so many skills cost almost nothing until they are used. The same format works in Claude Code and other Agent Skills tools.

## Steps

1. Understand the job. If the user has not said, ask (with ask_user when available) what the skill should do, two or three example requests that should trigger it, and what a good result looks like. Skip questions the conversation already answers.
2. Pick a name: lowercase letters, digits and hyphens, at most 64 characters, describing the job (\`weekly-report\`, \`invoice-from-timesheet\`, \`urdu-translation\`).
3. Write the description (one or two sentences, at most 1024 characters). It is the only thing the agent sees when deciding whether to use the skill, so say both what it does and when to use it: "Writes the weekly client report from the team's notes. Use when the user asks for the weekly report, a status update for a client, or a summary of this week's work."
4. Write the instructions:
   - Start with the goal and the expected output (format, length, language, file type).
   - Give a numbered procedure for the steps that matter; leave out what any capable assistant already knows.
   - Include templates, checklists, examples of good output, and the mistakes to avoid.
   - Keep SKILL.md under about 400 lines. Put long reference material in extra files (for example \`reference.md\`) and say in SKILL.md when to read them.
   - For repeatable mechanical work (converting files, calling an API, computing numbers) add a script under \`scripts/\` and tell the agent how to run it in Work mode.
5. Save it with create_skill (name, description, instructions and any extra files). Then tell the user it is ready, that it appears in Customize → Skills, and that they can run it directly by typing \`/name\` in the message box.
6. If the user wants changes later, call create_skill again with replace set to true.

## Quality checklist

- The description says when to use it, with the words a user would actually type.
- Instructions are specific: concrete formats, names, numbers, examples.
- No secrets (passwords, API keys) inside the skill.
- Scripts are referenced with paths relative to the skill folder.
`;

const CODE_REVIEW = `# Code review

Review code the way a careful senior engineer would: find real problems first, style last.

## Procedure

1. Establish what to review. In a git repository run \`git status\` and \`git diff\` (or \`git diff main...HEAD\` for a branch); otherwise review the files the user names. Read every changed file in full around the changes, not only the diff lines.
2. Understand the intent: read the related code, tests and docs so you know what the change is supposed to do.
3. Check, in this order:
   - **Correctness**: wrong logic, off-by-one, null/undefined handling, error paths, race conditions, broken edge cases (empty input, large input, unicode, time zones).
   - **Security**: injection (SQL, shell, HTML), secrets in code, missing auth checks, unsafe file paths, unvalidated input.
   - **Data and state**: migrations, backwards compatibility, cache invalidation, resource leaks (files, connections, listeners).
   - **Tests**: does a test cover the change? Would it fail if the change were wrong?
   - **Clarity**: confusing names, dead code, duplication that will drift.
4. Verify before you claim: when unsure whether something is a bug, read the code it calls, or run the tests or a quick check in Work mode.

## Report

Start with a one-line verdict (ready / needs changes). Then list findings, most severe first. For each: \`file:line\`, what is wrong, a concrete failing scenario, and the fix (a short code snippet when it helps). Mark each as **Bug**, **Risk** or **Nit**. Do not pad the review with praise or with nits when there are real bugs. If you find nothing important, say so plainly.
`;

const DEBUGGING = `# Systematic debugging

Find the root cause before changing code. Guessing wastes time and hides the real bug.

## Procedure

1. **Reproduce.** Get the exact error message, stack trace and the steps or command that trigger it. Run it yourself in Work mode and keep the full output.
2. **Read the evidence.** Read the stack trace from the top frame in the user's code. Open those files and read the surrounding code.
3. **Form hypotheses.** List two or three possible causes, most likely first, each with what you would expect to see if it were true.
4. **Test one hypothesis at a time** with the smallest possible check: add a log line, print a value, run a single test, check a version (\`npm ls\`, \`pip show\`), or inspect the data. Remove temporary logging afterwards.
5. **Search when it is unfamiliar.** Search the exact error message (in quotes) with web_search, read the library's issue tracker and docs for the installed version.
6. **Fix the cause, not the symptom.** Make the smallest change that fixes the root cause. Do not swallow errors or add retries to hide a bug.
7. **Verify.** Re-run the failing command and the related tests. Check that nothing else broke.
8. **Explain** in two or three sentences: what was wrong, why, and what changed.

If three different approaches fail, stop and summarize what you tried and what you learned, then ask the user for the missing information.
`;

const RESEARCH = `# Research report

Produce a well-sourced answer to a question that needs current or detailed information.

## Procedure

1. Restate the question in one sentence and list the 3-6 sub-questions that must be answered.
2. Search for each sub-question with web_search, using specific terms and the current year where versions or prices matter. Prefer primary sources: official documentation, company pages, papers, government data, original announcements.
3. Open the best 4-8 results with fetch_url and read them. Note each fact with its source. When sources disagree, note both and prefer the more recent and more authoritative one.
4. Stop when the sub-questions are answered with good sources, not when you run out of searches.

## Report format

- **Short answer** first: two to four sentences that directly answer the question.
- **Details** under clear headings, one per sub-question, with tables for comparisons (prices, features, versions).
- Cite every non-obvious claim inline as a Markdown link to the page you read.
- **Caveats**: what is uncertain, out of date, or could not be verified.
- Match the user's language (English, Urdu or Roman Urdu).
`;

const EMAIL_WRITER = `# Professional writing

Write emails, messages, letters and short documents that are clear and ready to send.

## Procedure

1. Identify the audience, the goal (inform, ask, apologize, follow up, persuade) and the tone (formal, friendly, firm). If the user gave little context and the message matters, ask one short question; otherwise make sensible assumptions and state them in one line.
2. Structure:
   - **Subject line** (for email): specific, under 60 characters.
   - **Opening**: the point or the request in the first one or two sentences.
   - **Body**: only the context the reader needs; bullet points for several items, dates, or steps.
   - **Close**: the exact next step, with a date when relevant, and a sign-off that fits the tone.
3. Style: short sentences, active voice, no filler ("I hope this email finds you well" only if the user wants it), no jargon the reader would not use. Keep most emails under 150 words.
4. Language: write in the language the user asks for. For Urdu use clear modern Urdu; for Roman Urdu keep common English terms as they are.

## Output

Give the ready-to-send text in a single block. If useful, add one alternative (shorter or more formal) below it. When Gmail is connected and the user asks, create a draft with the Gmail tools instead of sending.
`;

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  {
    name: 'skill-creator',
    description: 'Creates a new Maitre skill (a SKILL.md with instructions, and optional scripts or references) from a description of a task. Use when the user asks to make, write, save or improve a skill, or wants Maitre to remember how to do a kind of task every time.',
    instructions: SKILL_CREATOR,
  },
  {
    name: 'code-review',
    description: 'Reviews code changes or files for bugs, security problems and missing tests, and reports findings with file and line. Use when the user asks to review code, a diff, a branch or a pull request, or asks whether code is ready.',
    instructions: CODE_REVIEW,
  },
  {
    name: 'debugging',
    description: 'Finds the root cause of an error, crash, failing test or wrong behaviour step by step before fixing it. Use when the user reports a bug, an error message or a stack trace, or says something does not work.',
    instructions: DEBUGGING,
  },
  {
    name: 'research-report',
    description: 'Researches a question on the web from several primary sources and writes a cited report with a short answer first. Use for comparisons, market or product research, current facts, prices, or any question that needs up-to-date sources.',
    instructions: RESEARCH,
  },
  {
    name: 'professional-writing',
    description: 'Writes clear, ready-to-send emails, messages, letters and short documents in English, Urdu or Roman Urdu. Use when the user asks to write, reply to, rewrite or polish an email or message.',
    instructions: EMAIL_WRITER,
  },
];
