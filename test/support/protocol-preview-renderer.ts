import { renderFrozenArtifact, type ArtifactRenderer } from '../../src/infrastructure/artifact-renderer.js';

export function protocolPreviewRenderer(diagnostic: (message: string) => void, render: ArtifactRenderer = renderFrozenArtifact): ArtifactRenderer {
  return async request => {
    request.signal.throwIfAborted();
    const first = await render(request);
    if (first.ok) return first;
    diagnostic(`Protocol preview first attempt: ${JSON.stringify(first)}`);
    if (first.failure.kind !== 'timeout' || first.diagnostics.some(item => ['browser_kill_failed', 'profile_cleanup_failed'].includes(item.code))) return first;
    request.signal.throwIfAborted();
    return render(request);
  };
}
