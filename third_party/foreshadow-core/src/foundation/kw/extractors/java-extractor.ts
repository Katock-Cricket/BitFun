import { LanguageKeywordExtractor } from "../extractor-interface";
import { baseFilter, stripLineComment, stripStringLiterals, tokenizeIdentifiers } from "./common-patterns";

/**
 * Java 语言关键词停用词表
 */
const JAVA_STOPWORDS: ReadonlySet<string> = new Set([
    // Java 保留字（完整列表）
    'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch',
    'char', 'class', 'const', 'continue', 'default', 'do', 'double',
    'else', 'enum', 'extends', 'final', 'finally', 'float', 'for',
    'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface',
    'long', 'native', 'new', 'package', 'private', 'protected', 'public',
    'return', 'short', 'static', 'strictfp', 'super', 'switch',
    'synchronized', 'this', 'throw', 'throws', 'transient', 'try',
    'void', 'volatile', 'while',
    // 字面量值
    'true', 'false', 'null',
    // Java 内置类型和常用类（java.lang.*，自动导入）
    'String', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Byte',
    'Short', 'Character', 'Number', 'Object', 'Class', 'Void',
    'Math', 'System', 'Runtime', 'Thread', 'Runnable', 'Comparable',
    'Iterable', 'Cloneable', 'AutoCloseable',
    'StringBuilder', 'StringBuffer', 'StringJoiner',
    'Exception', 'RuntimeException', 'Error', 'Throwable',
    'NullPointerException', 'IllegalArgumentException',
    'IllegalStateException', 'IndexOutOfBoundsException',
    'ArrayIndexOutOfBoundsException', 'ClassCastException',
    'UnsupportedOperationException', 'StackOverflowError',
    'OutOfMemoryError', 'NumberFormatException',
    // java.util 常用类
    'ArrayList', 'LinkedList', 'HashMap', 'HashSet', 'LinkedHashMap',
    'LinkedHashSet', 'TreeMap', 'TreeSet', 'ArrayDeque', 'PriorityQueue',
    'Collections', 'Arrays', 'Objects', 'Optional',
    'Iterator', 'ListIterator', 'Comparator',
    'List', 'Map', 'Set', 'Queue', 'Deque', 'Collection',
    // java.util.stream / java.util.function
    'Stream', 'Collectors', 'Function', 'Predicate', 'Consumer', 'Supplier',
    'BiFunction', 'BiPredicate', 'BiConsumer', 'UnaryOperator', 'BinaryOperator',
    // 注解关键字
    'Override', 'Deprecated', 'SuppressWarnings', 'FunctionalInterface',
    'SafeVarargs', 'Retention', 'Target', 'Documented', 'Inherited',
    // 常用 Javadoc 标签（出现在注释行中）
    'param', 'return', 'throws', 'author', 'version', 'since', 'serial',
    // 常见约定词
    'args', 'main', 'equals', 'hashCode', 'toString', 'compareTo',
    'iterator', 'hasNext', 'getValue', 'getKey', 'setValue',
]);

export class JavaKeywordExtractor implements LanguageKeywordExtractor {
    extractKeywords(line: string): string[] {
        const stripped = stripStringLiterals(stripLineComment(line, 'java'));
        const tokens = tokenizeIdentifiers(stripped);
        return baseFilter(tokens, JAVA_STOPWORDS);
    }
}
