import { canonicalRecordedRoot, pathContainedBy } from '../../core/paths.js';

export type CodexProjectRef = {
  readonly id: string;
  readonly rootPaths: readonly string[];
};

export type CodexProjectClassification = 'project' | 'projectless' | 'unknown';
export type CodexProjectEvidence =
  | 'assignment'
  | 'sqlite-project-id'
  | 'workspace-hint'
  | 'cwd'
  | 'explicit-projectless'
  | 'none';

export type CodexProjectAttribution = {
  readonly projectId?: string;
  readonly projectRoot?: string;
  readonly classification: CodexProjectClassification;
  readonly evidence: CodexProjectEvidence;
};

export function classifyCodexProject(input: {
  readonly threadId: string;
  readonly sqliteProjectId?: string;
  readonly cwd?: string;
  readonly assignment?: string;
  readonly workspaceHint?: string;
  readonly projectless: ReadonlySet<string>;
  readonly projectsById: ReadonlyMap<string, CodexProjectRef>;
}): CodexProjectAttribution {
  if (input.projectless.has(input.threadId)) {
    return { classification: 'projectless', evidence: 'explicit-projectless' };
  }
  const assigned = attributedProject(input.assignment, input.projectsById, 'assignment');
  if (assigned) return assigned;
  const sqlite = attributedProject(input.sqliteProjectId, input.projectsById, 'sqlite-project-id');
  if (sqlite) return sqlite;
  const hinted = matchKnownRoot(input.workspaceHint, input.projectsById, 'workspace-hint');
  if (hinted) return hinted;
  const cwd = matchKnownRoot(input.cwd, input.projectsById, 'cwd');
  if (cwd) return cwd;
  if (input.cwd) return { projectRoot: input.cwd, classification: 'project', evidence: 'cwd' };
  return { classification: 'projectless', evidence: 'none' };
}

function attributedProject(
  projectId: string | undefined,
  projectsById: ReadonlyMap<string, CodexProjectRef>,
  evidence: 'assignment' | 'sqlite-project-id',
): CodexProjectAttribution | undefined {
  if (!projectId) return undefined;
  const project = projectsById.get(projectId);
  if (!project) return { projectId, classification: 'unknown', evidence };
  const projectRoot = project.rootPaths[0];
  return {
    projectId,
    ...(projectRoot ? { projectRoot } : {}),
    classification: projectRoot ? 'project' : 'unknown',
    evidence,
  };
}

function matchKnownRoot(
  path: string | undefined,
  projectsById: ReadonlyMap<string, CodexProjectRef>,
  evidence: 'workspace-hint' | 'cwd',
): CodexProjectAttribution | undefined {
  const canonical = canonicalRecordedRoot(path);
  if (!canonical || !path) return undefined;
  for (const project of projectsById.values()) {
    const root = project.rootPaths[0];
    if (!root) continue;
    if (pathContainedBy(root, path) || pathContainedBy(path, root)) {
      return { projectId: project.id, projectRoot: root, classification: 'project', evidence };
    }
  }
  return undefined;
}
