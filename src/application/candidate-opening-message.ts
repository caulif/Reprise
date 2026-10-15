import { resolve } from 'node:path';
import type { TaskCase } from '../core/schema.js';
import type { ImportedTaskInput } from './session-start-workspace.js';

export function candidateOpeningMessage(input: {
  message: string;
  taskCase: TaskCase;
  workspaceRoot: string;
  sourceRoot?: string;
  historicalCwd?: string | undefined;
  importedInputs: readonly ImportedTaskInput[];
}): string {
  const execution = input.taskCase.execution;
  if (execution?.mode !== 'task_completion') return input.message;
  const missingTask = [execution.goal, ...execution.deliverables].filter(text => !input.message.includes(text));
  return [
    input.message,
    '# Host task execution information',
    ...(missingTask.length ? [`Frozen goal / deliverables (verbatim):\n${missingTask.join('\n')}`] : []),
    `Working copy / input root: ${input.workspaceRoot}`,
    ...[...new Set([input.sourceRoot, input.historicalCwd].filter((root): root is string => Boolean(root)))].map(root =>
      `Original workspace ${root} maps to this working copy; use the copy paths.`),
    ...input.importedInputs.map(row => `Copied input: ${row.source} -> ${resolve(input.workspaceRoot, row.relative)}`),
    'Delivery location: save files and drafts within this working copy, using the task-specified relative locations. Original-directory paths refer to copies here unless explicitly authorized otherwise.',
    'Task defaults, only where explicit task authorization does not say otherwise: local modifications in this working copy, dependency installation as needed, build/tests, and saving drafts. Do not affect original user directories, production applications, or other tasks. Do not push, create/modify/comment on/merge cloud PRs or issues, or publish. Do not initiate local commits without explicit task authorization.',
    'The explicit authorization below takes precedence over these defaults and conflicting repository operation conventions. Dependency installation does not expand authorization; obey all explicit task restrictions. These are task-level instructions, not OS sandboxing or technical permission isolation.',
    `execution.authorization (verbatim):\n${execution.authorization}`,
  ].join('\n\n');
}
