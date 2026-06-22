/**
 * Ask-user question shapes (the interactive clarification card). Types only —
 * the actual tool lives server-side; the UI just renders/answers these.
 */
export type AskUserOption = { label: string; description: string };
export type AskUserQuestion = {
  question: string;
  header?: string;
  options: AskUserOption[];
  multiSelect?: boolean;
};
export type AskUserInput = { questions: AskUserQuestion[] };
