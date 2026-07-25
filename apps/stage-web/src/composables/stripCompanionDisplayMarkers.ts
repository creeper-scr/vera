/**
 * Removes Live2D/stage control markers from companion chat text.
 *
 * Covers standard `<|ACT …|>` / `<|DELAY …|>` / `<|CALL …|>` tokens and the
 * common model typo `<IACT …|>` (missing `|` after `<`).
 */
export function stripCompanionDisplayMarkers(text: string): string {
  return text
    .replace(/<\|\s*(?:ACT|DELAY|CALL)\b[\s\S]*?\|>/gi, '')
    .replace(/<I?ACT\b[\s\S]*?\|>/gi, '')
    .replace(/<\|?DELAY\b[\s\S]*?\|>/gi, '')
    .replace(/<\|?CALL\b[\s\S]*?\|>/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}
