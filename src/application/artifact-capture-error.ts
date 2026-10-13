import type { ArtifactRef } from '../core/schema.js';

export class ArtifactCaptureError extends Error {
  constructor(message: string, readonly artifactRefs: readonly ArtifactRef[]) {
    super(message);
  }
}
