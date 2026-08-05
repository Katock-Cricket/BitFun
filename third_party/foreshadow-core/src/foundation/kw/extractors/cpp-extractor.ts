import { LanguageKeywordExtractor } from "../extractor-interface";
import { baseFilter, stripLineComment, stripStringLiterals, tokenizeIdentifiers } from "./common-patterns";

/**
 * C / C++ 语言关键词停用词表
 */
const CPP_STOPWORDS: ReadonlySet<string> = new Set([
    // C 语言保留字
    'auto', 'break', 'case', 'char', 'const', 'continue', 'default',
    'do', 'double', 'else', 'enum', 'extern', 'float', 'for', 'goto',
    'if', 'inline', 'int', 'long', 'register', 'restrict', 'return',
    'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef',
    'union', 'unsigned', 'void', 'volatile', 'while',
    // C99/C11/C23 新增
    '_Bool', '_Complex', '_Imaginary', '_Alignas', '_Alignof',
    '_Atomic', '_Generic', '_Noreturn', '_Static_assert', '_Thread_local',
    'alignas', 'alignof', 'constexpr', 'nullptr', 'static_assert', 'thread_local',
    // C++ 额外保留字
    'asm', 'catch', 'class', 'delete', 'explicit', 'export', 'false',
    'friend', 'namespace', 'new', 'noexcept', 'operator', 'override',
    'private', 'protected', 'public', 'template', 'this', 'throw',
    'true', 'try', 'typeid', 'typename', 'using', 'virtual', 'nullptr',
    'concept', 'co_await', 'co_return', 'co_yield', 'requires',
    'decltype', 'final', 'mutable', 'reinterpret_cast', 'static_cast',
    'dynamic_cast', 'const_cast',
    // 预处理指令关键字（出现在 token 流中）
    'include', 'define', 'ifdef', 'ifndef', 'endif', 'elif', 'undef',
    'pragma', 'error', 'warning', 'defined',
    // C++ 标准库极常用类型/类（不具备项目语义）
    'string', 'wstring', 'vector', 'array', 'deque', 'list', 'forward_list',
    'stack', 'queue', 'priority_queue', 'set', 'multiset', 'map', 'multimap',
    'unordered_set', 'unordered_map', 'bitset', 'valarray',
    'pair', 'tuple', 'optional', 'variant', 'any', 'span',
    'iostream', 'istream', 'ostream', 'ifstream', 'ofstream', 'fstream',
    'stringstream', 'istringstream', 'ostringstream',
    'cin', 'cout', 'cerr', 'clog', 'endl',
    'shared_ptr', 'unique_ptr', 'weak_ptr', 'make_shared', 'make_unique',
    'function', 'bind', 'thread', 'mutex', 'condition_variable',
    'atomic', 'future', 'promise', 'async', 'launch',
    'sort', 'find', 'equal', 'count', 'transform', 'remove', 'reverse',
    'begin', 'cbegin', 'rbegin', 'crbegin',
    'allocator', 'iterator', 'initializer_list',
    // namespace std 限定词
    'std', 'NULL', 'nullptr',
    // 常见 C 标准库函数名
    'printf', 'scanf', 'fprintf', 'fscanf', 'sprintf', 'sscanf',
    'malloc', 'calloc', 'realloc', 'free', 'memset', 'memcpy', 'memmove',
    'strlen', 'strcpy', 'strncpy', 'strcmp', 'strncmp', 'strcat', 'strncat',
    'strtol', 'strtod', 'atoi', 'atof', 'atol',
    'fopen', 'fclose', 'fread', 'fwrite', 'fgets', 'fputs',
    'abort', 'exit', 'atexit', 'assert',
]);

export class CppKeywordExtractor implements LanguageKeywordExtractor {
    extractKeywords(line: string): string[] {
        const stripped = stripStringLiterals(stripLineComment(line, 'cpp'));
        const tokens = tokenizeIdentifiers(stripped);
        return baseFilter(tokens, CPP_STOPWORDS);
    }
}
