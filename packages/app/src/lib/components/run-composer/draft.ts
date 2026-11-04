/** Text only: uploaded images belong to a mounted composer and are not durable drafts. */
export function taskDraftKey(userId: string, taskId: string): string {
  return `ryph:task-draft:${JSON.stringify([userId, taskId])}`;
}

export function readDraft(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function saveDraft(key: string, text: string): void {
  try {
    if (text === "") localStorage.removeItem(key);
    else localStorage.setItem(key, text);
  } catch {
    // Blocked storage or a full quota must not prevent composing or sending.
  }
}

/** A send may finish after navigation; do not erase a newer draft written in another box. */
export function clearSentDraft(key: string, sent: string): void {
  if (readDraft(key) === sent) saveDraft(key, "");
}
