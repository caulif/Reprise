import { canonicalRecordedRoot, longestContainingRoot, pathContainedBy } from '../../core/paths.js';

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
  const hinted = matchWorkspaceHint(input.workspaceHint, input.projectsById);
  if (hinted) return hinted;
  const cwd = matchCwdRoot(input.cwd, input.projectsById);
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

function matchCwdRoot(
  path: string | undefined,
  projectsById: ReadonlyMap<string, CodexProjectRef>,
): CodexProjectAttribution | undefined {
  if (!path || !canonicalRecordedRoot(path)) return undefined;
  return attributionForRoot(longestContainingRoot(path, projectRoots(projectsById)), projectsById, 'cwd');
}

function matchWorkspaceHint(
  path: string | undefined,
  projectsById: ReadonlyMap<string, CodexProjectRef>,
): CodexProjectAttribution | undefined {
  if (!path || !canonicalRecordedRoot(path)) return undefined;
  const inside = attributionForRoot(longestContainingRoot(path, projectRoots(projectsById)), projectsById, 'workspace-hint');
  if (inside) return inside;
  const children = [...projectsById.values()].filter((project) => {
    const root = project.rootPaths[0];
    return Boolean(root && pathContainedBy(path, root));
  });
  if (children.length !== 1) return undefined;
  const project = children[0]!;
  const projectRoot = project.rootPaths[0];
  return { projectId: project.id, ...(projectRoot ? { projectRoot } : {}), classification: 'project', evidence: 'workspace-hint' };
}

function projectRoots(projectsById: ReadonlyMap<string, CodexProjectRef>): string[] {
  return [...projectsById.values()].flatMap((project) => project.rootPaths[0] ? [project.rootPaths[0]] : []);
}

function attributionForRoot(
  root: string | undefined,
  projectsById: ReadonlyMap<string, CodexProjectRef>,
  evidence: 'cwd' | 'workspace-hint',
): CodexProjectAttribution | undefined {
  if (!root) return undefined;
  const project = [...projectsById.values()].find((candidate) => candidate.rootPaths[0] === root);
  if (!project) return undefined;
  return { projectId: project.id, projectRoot: root, classification: 'project', evidence };
}
