/**
 * Terminal command output truncation for Foreshadow (SPEC D4 / §5.4).
 *
 * Budget is measured in JavaScript string length (UTF-16 code units).
 * When over the limit, keep head 32KB + tail 32KB and insert the SPEC marker.
 */

/** Max retained command output length (UTF-16 code units). */
export const FORESHADOW_TERMINAL_OUTPUT_MAX_CHARS = 65_536;

/** Head / tail budget when truncating (half of max). */
export const FORESHADOW_TERMINAL_OUTPUT_HALF_CHARS =
  FORESHADOW_TERMINAL_OUTPUT_MAX_CHARS / 2;

/** SPEC truncation marker between head and tail. */
export const FORESHADOW_TERMINAL_OUTPUT_TRUNCATION_MARKER =
  '\n...[truncated]...\n';

/**
 * Apply the locked 64KB head/tail truncation policy.
 * Returns the original string when it already fits.
 */
export function truncateTerminalOutput(
  output: string,
  maxChars: number = FORESHADOW_TERMINAL_OUTPUT_MAX_CHARS,
): string {
  if (maxChars <= 0) {
    return '';
  }
  if (output.length <= maxChars) {
    return output;
  }

  const headBudget = Math.floor(maxChars / 2);
  const tailBudget = maxChars - headBudget;
  const head = output.slice(0, headBudget);
  const tail = output.slice(output.length - tailBudget);
  return `${head}${FORESHADOW_TERMINAL_OUTPUT_TRUNCATION_MARKER}${tail}`;
}
