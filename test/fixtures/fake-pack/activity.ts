import { record, text } from '../../../src/core/json.js';
import type { EventEnvelope } from '../../../src/core/schema.js';
import type { TargetActivityTranslator, TargetRunFacts } from '../../../src/products/contract.js';

export const fakeActivityTranslator: TargetActivityTranslator = {
  translate(event) {
    if (!event.type.startsWith('fake.')) return [];
    const payload = record(event.payload);
    if (event.type === 'fake.message') {
      const body = text(payload.text);
      return body ? [{ activity: { kind: 'message', text: body } }] : [];
    }
    if (event.type === 'fake.other') {
      const body = text(payload.body);
      return [{ activity: { kind: 'other', label: text(payload.label) ?? 'note', ...(body ? { body } : {}) } }];
    }
    return [];
  },
  inspectRunFacts(events: readonly EventEnvelope[]): TargetRunFacts {
    const messages = events.filter((event) => event.type === 'fake.message');
    const finalMessage = messages.map((event) => text(record(event.payload).text)).filter((value): value is string => Boolean(value)).at(-1);
    return {
      ...(finalMessage ? { finalMessage } : {}),
      commands: [],
      rejectedApprovals: 0,
      evidenceEvents: messages,
    };
  },
};
