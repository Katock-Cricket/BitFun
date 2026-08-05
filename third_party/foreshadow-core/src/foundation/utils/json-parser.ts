export function extractJSON(text: string): string | null {
  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) {
    return null;
  }
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = firstBrace; i < text.length; i++) {
    const char = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === '{') {
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount === 0) {
          return text.substring(firstBrace, i + 1);
        }
      }
    }
  }
  return null;
}

export function cleanMarkdownCodeBlock(content: string): string {
  let cleaned = content.trim();
  cleaned = cleaned.replace(/^```json\s*/gm, '');
  cleaned = cleaned.replace(/^```\s*/gm, '');
  return cleaned;
}

export function fixControlCharactersInJSON(jsonString: string): string {
  let inString = false;
  let escapeNext = false;
  let fixed = '';
  for (let i = 0; i < jsonString.length; i++) {
    const char = jsonString[i];
    if (escapeNext) {
      fixed += char;
      escapeNext = false;
      continue;
    }
    if (char === '\\') {
      escapeNext = true;
      fixed += char;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      fixed += char;
      continue;
    }
    if (inString) {
      switch (char) {
        case '\n': fixed += '\\n'; break;
        case '\r': fixed += '\\r'; break;
        case '\t': fixed += '\\t'; break;
        default: fixed += char; break;
      }
    } else {
      fixed += char;
    }
  }
  return fixed;
}

export function parseAIResponseWithDetails<T = any>(
  content: string,
  logPrefix: string = 'AI Response',
): { success: boolean; data: T | null; error?: string; extractedJSON?: string } {
  try {
    const cleaned = cleanMarkdownCodeBlock(content);
    const jsonContent = extractJSON(cleaned);
    if (!jsonContent) {
      const error = `${logPrefix}: No valid JSON found in response`;
      console.warn(error);
      return { success: false, data: null, error };
    }
    const fixedJsonContent = fixControlCharactersInJSON(jsonContent);
    const parsed = JSON.parse(fixedJsonContent);
    return { success: true, data: parsed as T, extractedJSON: fixedJsonContent };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`${logPrefix}: Failed to parse JSON:`, error);
    return { success: false, data: null, error: errorMsg };
  }
}
