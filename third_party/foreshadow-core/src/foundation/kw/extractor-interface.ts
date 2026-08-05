/**
 * 语言关键词提取器接口
 * 每种语言实现此接口，提供从一行代码中提取项目级语义关键词的能力
 */
export interface LanguageKeywordExtractor {
    extractKeywords(line: string): string[];
}
