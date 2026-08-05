import { LanguageKeywordExtractor } from "../extractor-interface";
import { baseFilter, stripLineComment, stripStringLiterals, tokenizeIdentifiers } from "./common-patterns";

/**
 * Python 语言关键词停用词表
 */
const PY_STOPWORDS: ReadonlySet<string> = new Set([
    // Python 保留字（完整列表）
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await',
    'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
    'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
    'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
    'try', 'while', 'with', 'yield',
    // Python 内置函数（不具备项目语义）
    'abs', 'all', 'any', 'ascii', 'bin', 'bool', 'breakpoint', 'bytearray',
    'bytes', 'callable', 'chr', 'compile', 'complex', 'copyright', 'credits',
    'delattr', 'dict', 'dir', 'divmod', 'enumerate', 'eval', 'exec',
    'float', 'format', 'frozenset', 'getattr', 'globals', 'hasattr', 'hash',
    'help', 'hex', 'input', 'int', 'isinstance', 'issubclass', 'iter',
    'len', 'license', 'list', 'locals', 'map', 'max', 'memoryview', 'min',
    'next', 'object', 'oct', 'open', 'ord', 'pow', 'print', 'property',
    'range', 'repr', 'reversed', 'round', 'set', 'setattr', 'slice',
    'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple', 'type',
    'vars', 'zip',
    // Python 内置异常/类型
    'Exception', 'BaseException', 'TypeError', 'ValueError', 'KeyError',
    'IndexError', 'AttributeError', 'RuntimeError', 'StopIteration',
    'GeneratorExit', 'SystemExit', 'KeyboardInterrupt', 'ImportError',
    'OSError', 'IOError', 'FileNotFoundError', 'PermissionError',
    'NotImplementedError', 'OverflowError', 'ZeroDivisionError',
    'MemoryError', 'RecursionError', 'BufferError', 'ArithmeticError',
    'LookupError', 'EnvironmentError', 'WindowsError',
    // 常用 dunder / 魔术属性
    '__init__', '__new__', '__del__', '__repr__', '__str__', '__bytes__',
    '__format__', '__hash__', '__bool__', '__len__', '__getitem__',
    '__setitem__', '__delitem__', '__iter__', '__next__', '__call__',
    '__enter__', '__exit__', '__slots__', '__dict__', '__class__',
    '__name__', '__module__', '__doc__', '__all__', '__file__',
    '__annotations__', '__qualname__', '__bases__', '__mro__',
    // 常用类型提示（typing 模块导出的）
    'Optional', 'Union', 'Tuple', 'List', 'Dict', 'Set', 'FrozenSet',
    'Callable', 'Awaitable', 'Coroutine', 'Generator', 'Iterator',
    'Iterable', 'Sequence', 'Mapping', 'MutableMapping', 'Any',
    'TypeVar', 'Generic', 'Protocol', 'ClassVar', 'Final', 'Literal',
    'Annotated', 'TypeAlias', 'overload', 'dataclass', 'field',
    'abstractmethod', 'classmethod', 'property',
    // 常见约定名
    'self', 'cls', 'args', 'kwargs',
]);

export class PythonKeywordExtractor implements LanguageKeywordExtractor {
    extractKeywords(line: string): string[] {
        const stripped = stripStringLiterals(stripLineComment(line, 'py'));
        const tokens = tokenizeIdentifiers(stripped);
        return baseFilter(tokens, PY_STOPWORDS);
    }
}
