export type IntakeSessionMemory = {
  readonly query: string;
  readonly cursor: number;
  readonly sessionId: string;
};

export type IntakeProductMemory = {
  projectQuery: string;
  projectCursor: number;
  projectKey: string;
  readonly sessionByProject: Map<string, IntakeSessionMemory>;
};

export function productMemory(store: Map<string, IntakeProductMemory>, productId: string): IntakeProductMemory {
  const existing = store.get(productId);
  if (existing) return existing;
  const created: IntakeProductMemory = {
    projectQuery: "",
    projectCursor: 0,
    projectKey: "",
    sessionByProject: new Map(),
  };
  store.set(productId, created);
  return created;
}

export function rememberProjects(
  memory: IntakeProductMemory,
  query: string,
  cursor: number,
  projectKey: string,
): void {
  memory.projectQuery = query;
  memory.projectCursor = cursor;
  memory.projectKey = projectKey;
}

export function rememberSessions(
  memory: IntakeProductMemory,
  projectKey: string,
  query: string,
  cursor: number,
  sessionId: string,
): void {
  memory.sessionByProject.set(projectKey, { query, cursor, sessionId });
}
