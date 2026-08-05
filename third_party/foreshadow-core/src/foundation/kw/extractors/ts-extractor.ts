import { LanguageKeywordExtractor } from "../extractor-interface";
import { baseFilter, stripLineComment, stripStringLiterals, tokenizeIdentifiers } from "./common-patterns";

/**
 * TypeScript / JavaScript / JSX / TSX 语言关键词停用词表
 * 包含所有语言内置关键字、内置类型名及运行时全局名，这些词不具有项目级语义。
 */
const TS_STOPWORDS: ReadonlySet<string> = new Set([
    // ECMAScript 保留字
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
    'default', 'delete', 'do', 'else', 'export', 'extends', 'finally',
    'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new',
    'of', 'return', 'static', 'super', 'switch', 'this', 'throw', 'try',
    'typeof', 'var', 'void', 'while', 'with', 'yield', 'enum',
    // 保留的未来关键字
    'implements', 'interface', 'package', 'private', 'protected', 'public',
    // 字面量值
    'null', 'undefined', 'true', 'false', 'NaN', 'Infinity',
    // TypeScript 专属关键字
    'abstract', 'as', 'async', 'await', 'declare', 'from', 'get',
    'infer', 'is', 'keyof', 'module', 'namespace', 'never', 'override',
    'readonly', 'require', 'satisfies', 'set', 'type', 'unique', 'using',
    // TypeScript 内置类型
    'any', 'bigint', 'boolean', 'never', 'number', 'object', 'string',
    'symbol', 'unknown', 'void',
    // 常用内置类/构造函数（不含 COMMON_GENERIC_STOPWORDS 中已有的）
    'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'Date', 'RegExp',
    'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
    'EvalError', 'URIError', 'Function', 'Generator', 'Iterator',
    'Proxy', 'Reflect', 'JSON', 'Math', 'Intl', 'Atomics',
    'ArrayBuffer', 'DataView', 'SharedArrayBuffer',
    'Int8Array', 'Int16Array', 'Int32Array',
    'Uint8Array', 'Uint16Array', 'Uint32Array',
    'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
    'Uint8ClampedArray',
    // 装饰器/常见框架约定词（框架内置，不算项目级）
    'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf',
    'then', 'catch', 'finally', 'resolve', 'reject', 'next', 'done',
    'throw', 'return',
]);

export class TypeScriptKeywordExtractor implements LanguageKeywordExtractor {
    extractKeywords(line: string): string[] {
        const stripped = stripStringLiterals(stripLineComment(line, 'ts'));
        const tokens = tokenizeIdentifiers(stripped);
        return baseFilter(tokens, TS_STOPWORDS);
    }
}
