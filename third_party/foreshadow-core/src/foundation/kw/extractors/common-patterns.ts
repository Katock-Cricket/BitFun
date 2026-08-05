import { kwMinTokenLength } from "../../config/constants";

/**
 * 跨语言通用停用词表：这些词虽然是合法标识符，但在项目间高度通用，
 * 不具备足以区分项目的语义特征，因此过滤。
 */
export const COMMON_GENERIC_STOPWORDS: ReadonlySet<string> = new Set([
    // 极通用变量名
    'index', 'value', 'values', 'data', 'datas', 'item', 'items',
    'result', 'results', 'count', 'counts', 'error', 'errors',
    'event', 'events', 'state', 'states', 'props', 'message',
    'messages', 'callback', 'callbacks', 'handler', 'handlers',
    'context', 'contexts', 'option', 'options', 'config', 'configs',
    'param', 'params', 'args', 'argument', 'arguments',
    'output', 'outputs', 'input', 'inputs', 'response', 'request',
    'listener', 'listeners', 'getter', 'setter',
    // 极通用动词/动作名
    'update', 'create', 'delete', 'remove', 'append', 'insert',
    'fetch', 'start', 'stop', 'reset', 'clear', 'apply', 'filter',
    'reduce', 'forEach', 'getters', 'setters', 'getter', 'setter',
    // 极通用结构词
    'target', 'source', 'scope', 'parent', 'child', 'children',
    'node', 'nodes', 'root', 'roots', 'element', 'elements',
    'object', 'objects', 'array', 'arrays', 'record', 'records',
    'entry', 'entries', 'field', 'fields', 'column', 'columns',
    'table', 'tables', 'model', 'models', 'schema', 'schemas',
    'instance', 'instances', 'entity', 'entities',
    // 内置全局对象（运行时通用）
    'Array', 'Object', 'String', 'Number', 'Boolean', 'Symbol',
    'Promise', 'console', 'window', 'document', 'process',
    'module', 'require', 'exports', 'global', 'Buffer',
    // 极通用属性名
    'length', 'size', 'width', 'height', 'name', 'names',
    'type', 'types', 'text', 'texts', 'label', 'labels',
    'title', 'titles', 'content', 'contents', 'body', 'bodies',
    'path', 'paths', 'query', 'queries', 'search',
]);

/**
 * 去除行尾注释（C 风格 // 和 Python 风格 #）
 * HTML/Vue 中的 <!-- --> 注释通常不会出现在单行 strip 场景中，忽略
 */
export function stripLineComment(line: string, suffix: string): string {
    if (suffix === 'py') {
        // Python：# 不在字符串内时为注释，简单取第一个裸 # 之前的部分
        const idx = findUnquotedChar(line, '#');
        return idx >= 0 ? line.slice(0, idx) : line;
    }
    if (suffix === 'html' || suffix === 'vue') {
        // HTML 注释：<!-- ... -->，可能单行也可能多行片段
        return line.replace(/<!--[\s\S]*?-->/g, '').replace(/<!--[\s\S]*/g, '');
    }
    // C 风格（ts/js/java/c/cpp 等）：// 不在字符串内时为注释
    const idx = findUnquotedDoubleSlash(line);
    return idx >= 0 ? line.slice(0, idx) : line;
}

/**
 * 去除字符串字面量内容（保留引号本身，避免误提取字符串中的词）
 * 支持单引号、双引号、模板字符串反引号
 */
export function stripStringLiterals(line: string): string {
    // 依次替换双引号、单引号、反引号字符串内容为占位符
    // 采用非贪心匹配，并处理转义字符
    return line
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * 从处理过的代码行中提取所有合法标识符 token
 * 符合主流语言命名规则：字母/下划线/$开头，后续可含数字
 */
export function tokenizeIdentifiers(line: string): string[] {
    return line.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g) ?? [];
}

/**
 * 核心过滤流程：去除长度不足和通用停用词后的 token 列表
 * 各语言 extractor 在此基础上再叠加语言专属停用词过滤
 */
export function baseFilter(tokens: string[], langStopwords: ReadonlySet<string>): string[] {
    return tokens.filter(t =>
        t.length > kwMinTokenLength &&
        !COMMON_GENERIC_STOPWORDS.has(t) &&
        !langStopwords.has(t)
    );
}

// ─── 内部工具函数 ───────────────────────────────────────────────────────────

/**
 * 找到行中第一个不在引号内的指定字符的索引，找不到返回 -1
 */
function findUnquotedChar(line: string, char: string): number {
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        const prev = i > 0 ? line[i - 1] : '';
        if (c === "'" && !inDouble && !inTemplate && prev !== '\\') { inSingle = !inSingle; continue; }
        if (c === '"' && !inSingle && !inTemplate && prev !== '\\') { inDouble = !inDouble; continue; }
        if (c === '`' && !inSingle && !inDouble && prev !== '\\') { inTemplate = !inTemplate; continue; }
        if (!inSingle && !inDouble && !inTemplate && c === char) {
            return i;
        }
    }
    return -1;
}

/**
 * 找到行中第一个不在引号内的 // 序列的索引，找不到返回 -1
 */
function findUnquotedDoubleSlash(line: string): number {
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    for (let i = 0; i < line.length - 1; i++) {
        const c = line[i];
        const prev = i > 0 ? line[i - 1] : '';
        if (c === "'" && !inDouble && !inTemplate && prev !== '\\') { inSingle = !inSingle; continue; }
        if (c === '"' && !inSingle && !inTemplate && prev !== '\\') { inDouble = !inDouble; continue; }
        if (c === '`' && !inSingle && !inDouble && prev !== '\\') { inTemplate = !inTemplate; continue; }
        if (!inSingle && !inDouble && !inTemplate && c === '/' && line[i + 1] === '/') {
            return i;
        }
    }
    return -1;
}
