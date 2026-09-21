export type IntakeSessionMemory = {
  readonly query: string;
  readonly cursor: number;
  readonly sessionId: string;
  readonly selectedIndex: number;
};

export type IntakeProductMemory = {
  projectQuery: string;
  projectCursor: number;
  projectKey: string;
  projectSelectedIndex: number;
  readonly sessionByProject: Map<string, IntakeSessionMemory>;
};

export function productMemory(store: Map<string, IntakeProductMemory>, productId: string): IntakeProductMemory {
  const existing = store.get(productId);
  if (existing) return existing;
  const created: IntakeProductMemory = {
    projectQuery: "",
    projectCursor: 0,
    projectKey: "",
    projectSelectedIndex: 0,
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
  selectedIndex = 0,
): void {
  memory.projectQuery = query;
  memory.projectCursor = cursor;
  memory.projectKey = projectKey;
  memory.projectSelectedIndex = selectedIndex;
}

export function rememberSessions(
  memory: IntakeProductMemory,
  projectKey: string,
  query: string,
  cursor: number,
  sessionId: string,
  selectedIndex = 0,
): void {
  memory.sessionByProject.set(projectKey, { query, cursor, sessionId, selectedIndex });
}

/** Restore selection by stable id; if missing, nearby index + lost flag. */
export function restoreById(
  items: readonly { readonly id: string }[],
  rememberedId: string,
  rememberedIndex: number,
): { index: number; lost: boolean } {
  if (!items.length) return { index: 0, lost: Boolean(rememberedId) };
  if (rememberedId) {
    const hit = items.findIndex((item) => item.id === rememberedId);
    if (hit >= 0) return { index: hit, lost: false };
  }
  const near = Math.max(0, Math.min(items.length - 1, rememberedIndex));
  return { index: near, lost: Boolean(rememberedId) };
}
