export const PAYMENT_APP_TAG = "quantalog";

export function taggedNotes<T extends Record<string, string>>(notes: T): T & { app: string } {
  return { ...notes, app: PAYMENT_APP_TAG };
}
