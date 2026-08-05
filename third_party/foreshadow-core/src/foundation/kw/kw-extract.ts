import { LanguageKeywordExtractor } from './extractor-interface';
import {
  stripLineComment,
  stripStringLiterals,
  tokenizeIdentifiers,
  baseFilter,
  COMMON_GENERIC_STOPWORDS,
} from './extractors/common-patterns';
import { TypeScriptKeywordExtractor } from './extractors/ts-extractor';
import { PythonKeywordExtractor } from './extractors/py-extractor';
import { JavaKeywordExtractor } from './extractors/java-extractor';
import { CppKeywordExtractor } from './extractors/cpp-extractor';
import { HtmlKeywordExtractor } from './extractors/html-extractor';
import { VueKeywordExtractor } from './extractors/vue-extractor';

export type { LanguageKeywordExtractor };

const extractorRegistry = new Map<string, LanguageKeywordExtractor>();

function registerExtractor(suffixes: string[], extractor: LanguageKeywordExtractor) {
  for (const suffix of suffixes) {
    extractorRegistry.set(suffix, extractor);
  }
}

registerExtractor(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'], new TypeScriptKeywordExtractor());
registerExtractor(['py', 'pyw', 'pyi'], new PythonKeywordExtractor());
registerExtractor(['java'], new JavaKeywordExtractor());
registerExtractor(['c', 'cpp', 'cxx', 'cc', 'h', 'hpp', 'hxx'], new CppKeywordExtractor());
registerExtractor(['html', 'htm', 'xhtml'], new HtmlKeywordExtractor());
registerExtractor(['vue'], new VueKeywordExtractor());

export function extractKeywordsFromLine(line: string, docSuffix: string): string[] {
  const extractor = extractorRegistry.get(docSuffix);
  if (extractor) {
    return extractor.extractKeywords(line);
  }
  const stripped = stripStringLiterals(stripLineComment(line, docSuffix));
  const tokens = tokenizeIdentifiers(stripped);
  return baseFilter(tokens, COMMON_GENERIC_STOPWORDS);
}
