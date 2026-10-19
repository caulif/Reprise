export type AgentLocale = "en" | "zh";

export type AgentLanguageRole = "recovery" | "controller" | "comparison";

const OPERATOR_LANGUAGE: Record<AgentLocale, string> = {
  zh: "Simplified Chinese",
  en: "English",
};

const BLOCKS: Record<AgentLanguageRole, (language: string) => string> = {
  recovery: (language) =>
    [
      "# Language",
      `Instructions and file navigation are in English. Text you write for the operator is in ${language}: process sentences and the summary, boundary statement and unresolved items of the final JSON.`,
      "Quote file contents, commands, paths, and identifiers verbatim; never translate them.",
    ].join("\n"),
  controller: (language) =>
    [
      "# Language",
      `Instructions and file navigation are in English. Process sentences and the rationale field are in ${language}.`,
      "Messages to the candidate (send.message) follow the language the historical user wrote in. Never switch them to the operator language, and never mix in Host terms.",
      "Quote file contents, commands, paths, and identifiers verbatim; never translate them.",
    ].join("\n"),
  comparison: (language) =>
    [
      "# Language",
      `Instructions and file navigation are in English. Report prose, headline, category, the task sentence, reason, paired differences, impacts, image captions and process sentences are in ${language}, regardless of the historical task's language. Keep this language for every revision and retry in this attempt.`,
      "Quoted source material stays in its original language. Code, paths, model IDs, and identifiers are never translated.",
    ].join("\n"),
};

export function LANGUAGE_BLOCK(locale: AgentLocale, role: AgentLanguageRole): string {
  return BLOCKS[role](OPERATOR_LANGUAGE[locale]);
}

export function withLanguageBlock(systemPrompt: string, locale: AgentLocale, role: AgentLanguageRole): string {
  return `${systemPrompt}\n\n${LANGUAGE_BLOCK(locale, role)}`;
}
