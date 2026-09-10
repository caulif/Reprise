export type {
  ImportedSession,
  ProductHistoryReader,
  SessionInspection,
  SessionPrivacy,
  SessionRef,
  SessionSummary,
} from "../contract.js";

export type ObservationOwnedFile = {
  readonly relativePath: string;
  readonly text?: string;
  readonly bytes?: Buffer;
  readonly missing?: boolean;
};

