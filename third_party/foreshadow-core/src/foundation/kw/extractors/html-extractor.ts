import { LanguageKeywordExtractor } from "../extractor-interface";
import { baseFilter, stripLineComment, stripStringLiterals, tokenizeIdentifiers } from "./common-patterns";

/**
 * 全套 HTML 原生标签名停用词表（HTML5 标准 + 废弃标签全收录）
 * 这些词是 HTML 规范定义的，不具备项目级语义特征。
 */
export const HTML_TAG_STOPWORDS: ReadonlySet<string> = new Set([
    // 文档结构
    'html', 'head', 'body', 'base', 'link', 'meta', 'style', 'title',
    'script', 'noscript', 'template', 'slot',
    // 区块/分组
    'article', 'aside', 'details', 'dialog', 'figcaption', 'figure',
    'footer', 'header', 'hgroup', 'main', 'menu', 'nav', 'section',
    'summary', 'div', 'span', 'blockquote', 'dd', 'dl', 'dt', 'li',
    'ol', 'ul', 'pre',
    // 标题
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    // 行内文本
    'abbr', 'cite', 'code', 'data', 'dfn', 'kbd', 'mark', 'rp', 'rt',
    'ruby', 'samp', 'small', 'sub', 'sup', 'time', 'var', 'wbr',
    'bdi', 'bdo', 'br', 'em', 'strong', 'italic', 'bold', 'underline',
    'del', 'ins', 'q', 's', 'u', 'b', 'i',
    // 编辑
    // 嵌入内容
    'audio', 'canvas', 'embed', 'iframe', 'img', 'math', 'object',
    'picture', 'portal', 'source', 'svg', 'track', 'video',
    // 表格
    'caption', 'col', 'colgroup', 'table', 'tbody', 'td', 'tfoot',
    'th', 'thead', 'tr',
    // 表单
    'button', 'datalist', 'fieldset', 'form', 'input', 'label', 'legend',
    'meter', 'optgroup', 'option', 'output', 'progress', 'select',
    'textarea',
    // 交互
    'details', 'dialog', 'summary',
    // Web Components
    'slot', 'template',
    // 废弃但仍常见
    'acronym', 'applet', 'basefont', 'bgsound', 'big', 'blink',
    'center', 'dir', 'font', 'frame', 'frameset', 'isindex', 'keygen',
    'listing', 'marquee', 'menuitem', 'multicol', 'nextid', 'nobr',
    'noembed', 'noframes', 'plaintext', 'spacer', 'strike', 'tt',
    'xmp', 'image',
    // 常见 HTML 属性关键字（不具备项目语义）
    'class', 'style', 'href', 'srcset', 'async', 'defer', 'charset',
    'content', 'media', 'method', 'action', 'enctype', 'accept',
    'multiple', 'required', 'disabled', 'readonly', 'checked', 'selected',
    'hidden', 'draggable', 'contenteditable', 'spellcheck', 'tabindex',
    'accesskey', 'autocomplete', 'autofocus', 'autoplay', 'controls',
    'crossorigin', 'download', 'loading', 'loop', 'muted', 'novalidate',
    'placeholder', 'preload', 'rel', 'sandbox', 'scope', 'target',
    'translate', 'typemustmatch', 'usemap', 'width', 'height',
    'colspan', 'rowspan', 'cellpadding', 'cellspacing', 'summary',
    'frameborder', 'scrolling', 'allowfullscreen', 'referrerpolicy',
]);

export class HtmlKeywordExtractor implements LanguageKeywordExtractor {
    extractKeywords(line: string): string[] {
        // HTML 中有意义的标识符主要是：自定义组件名（PascalCase）、JS 表达式中的变量名
        // 统一走 tokenize 流程，通过停用词表过滤掉原生标签和属性
        const stripped = stripStringLiterals(stripLineComment(line, 'html'));
        const tokens = tokenizeIdentifiers(stripped);
        return baseFilter(tokens, HTML_TAG_STOPWORDS);
    }
}
