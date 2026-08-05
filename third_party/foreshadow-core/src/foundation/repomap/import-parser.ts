import { ArtifactContextItem } from '../domain/artifact-context';
import { FsUri, Location, makeLocation, makePosition, makeRange } from '../domain/geometry';

const LANGUAGE_PATTERNS: Record<string, RegExp> = {
  typescript: /^(import\s+.*|export\s+\{.*\}\s+from\s+.*|const\s+\w+\s*=\s*require\s*\(.*\);?)$/,
  javascript: /^(import\s+.*|export\s+\{.*\}\s+from\s+.*|const\s+\w+\s*=\s*require\s*\(.*\);?)$/,
  typescriptreact: /^(import\s+.*|export\s+\{.*\}\s+from\s+.*|const\s+\w+\s*=\s*require\s*\(.*\);?)$/,
  javascriptreact: /^(import\s+.*|export\s+\{.*\}\s+from\s+.*|const\s+\w+\s*=\s*require\s*\(.*\);?)$/,
  python: /^(import\s+.*|from\s+\S+\s+import\s+.*)$/,
  go: /^import\s+(?:\(|".*"\)|".*")$/,
  rust: /^use\s+.*;$/,
  java: /^import\s+(static\s+)?[\w.*]+;$/,
  csharp: /^using\s+(static\s+)?[\w.]+;$/,
  cpp: /^#\s*include\s+["<].*[>"]/,
  php: /^(use\s+.*;|require_once\s+.*|include_once\s+.*)$/,
};

export function extractImportBlock(location: Location, fileContent: string): ArtifactContextItem | undefined {
  const languageId = getLanguageIdFromUri(location.uri);
  const pattern = LANGUAGE_PATTERNS[languageId];
  if (!pattern) return undefined;

  const lines = fileContent.split('\n');
  if (lines.length === 0) return undefined;

  let importStartLine = -1;
  let lastImportLine = -1;
  let consecutiveEmptyLines = 0;
  let inGoImportBlock = false;
  let inMultiLineImport = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    if (trimmedLine === '') {
      if (importStartLine !== -1) {
        consecutiveEmptyLines++;
        if (consecutiveEmptyLines > 2) break;
      }
      continue;
    }
    consecutiveEmptyLines = 0;

    if (isCommentLine(trimmedLine, languageId)) {
      if (importStartLine !== -1) lastImportLine = i;
      continue;
    }

    if (languageId === 'go') {
      if (trimmedLine.startsWith('import') && trimmedLine.includes('(')) {
        inGoImportBlock = true;
        if (importStartLine === -1) importStartLine = i;
        lastImportLine = i;
        if (trimmedLine.includes(')')) inGoImportBlock = false;
        continue;
      }
      if (inGoImportBlock) {
        lastImportLine = i;
        if (trimmedLine.includes(')')) inGoImportBlock = false;
        continue;
      }
    }

    if (inMultiLineImport) {
      lastImportLine = i;
      if (isMultiLineImportEnd(trimmedLine, languageId)) inMultiLineImport = false;
      continue;
    }

    if (pattern.test(trimmedLine)) {
      if (importStartLine === -1) importStartLine = i;
      lastImportLine = i;
      if (isMultiLineImportStart(trimmedLine, languageId)) inMultiLineImport = true;
      continue;
    }

    if (importStartLine !== -1) break;
  }

  if (importStartLine === -1 || lastImportLine === -1) return undefined;
  const importLines = lines.slice(importStartLine, lastImportLine + 1);
  const codeSnippet = importLines.join('\n');
  const range = makeRange(
    makePosition(importStartLine, 0),
    makePosition(lastImportLine, lines[lastImportLine].length),
  );
  return new ArtifactContextItem(makeLocation(location.uri, range), codeSnippet, 0, 0);
}

function getLanguageIdFromUri(uri: FsUri): string {
  const extMap: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.js': 'javascript',
    '.jsx': 'javascriptreact',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.cs': 'csharp',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.hpp': 'cpp',
    '.h': 'cpp',
    '.c': 'cpp',
    '.php': 'php',
  };
  const fileName = uri.fsPath.toLowerCase();
  for (const [ext, lang] of Object.entries(extMap)) {
    if (fileName.endsWith(ext)) return lang;
  }
  return 'unknown';
}

function isCommentLine(trimmedLine: string, languageId: string): boolean {
  if (['typescript', 'javascript', 'typescriptreact', 'javascriptreact', 'java', 'csharp', 'cpp', 'go', 'rust', 'php'].includes(languageId)) {
    return trimmedLine.startsWith('//') || trimmedLine.startsWith('/*') || trimmedLine.startsWith('*') || trimmedLine === '*/';
  }
  if (languageId === 'python') return trimmedLine.startsWith('#');
  return false;
}

function isMultiLineImportStart(trimmedLine: string, languageId: string): boolean {
  if (['typescript', 'javascript', 'typescriptreact', 'javascriptreact'].includes(languageId)) {
    if (trimmedLine.startsWith('import') && trimmedLine.includes('{') && !trimmedLine.includes('}')) return true;
    if (trimmedLine.startsWith('import') && !trimmedLine.endsWith(';') && !trimmedLine.endsWith('"') && !trimmedLine.endsWith("'")) return true;
  }
  if (languageId === 'python') {
    if (trimmedLine.startsWith('from') && trimmedLine.includes('(') && !trimmedLine.includes(')')) return true;
  }
  return false;
}

function isMultiLineImportEnd(trimmedLine: string, languageId: string): boolean {
  if (['typescript', 'javascript', 'typescriptreact', 'javascriptreact'].includes(languageId)) {
    return trimmedLine.includes('}') || trimmedLine.endsWith(';');
  }
  if (languageId === 'python') return trimmedLine.includes(')');
  return true;
}
