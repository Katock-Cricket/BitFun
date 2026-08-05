import { LanguageKeywordExtractor } from "../extractor-interface";
import { baseFilter, stripLineComment, stripStringLiterals, tokenizeIdentifiers } from "./common-patterns";
import { HTML_TAG_STOPWORDS } from "./html-extractor";

/**
 * Vue 特有的内置指令/编译器宏/运行时 API 停用词表
 * 这些词是 Vue 框架本身定义的，不具备项目级语义特征。
 */
const VUE_BUILTIN_STOPWORDS: ReadonlySet<string> = new Set([
    // 模板指令（v-xxx 去掉 v- 后的名称，以及驼峰形式）
    'vIf', 'vElse', 'vElseIf', 'vShow', 'vFor', 'vBind', 'vOn',
    'vModel', 'vSlot', 'vOnce', 'vMemo', 'vPre', 'vCloak', 'vHtml', 'vText',
    // Composition API 宏（<script setup>）
    'defineComponent', 'defineProps', 'defineEmits', 'defineExpose',
    'defineSlots', 'defineOptions', 'withDefaults', 'useSlots', 'useAttrs',
    // Composition API 核心
    'setup', 'ref', 'reactive', 'computed', 'watch', 'watchEffect',
    'watchPostEffect', 'watchSyncEffect', 'readonly', 'shallowRef',
    'shallowReactive', 'shallowReadonly', 'triggerRef', 'customRef',
    'toRef', 'toRefs', 'toValue', 'toRaw', 'markRaw', 'isRef', 'isProxy',
    'isReactive', 'isReadonly', 'unref', 'proxyRefs',
    // 生命周期钩子
    'onMounted', 'onUnmounted', 'onBeforeMount', 'onBeforeUnmount',
    'onUpdated', 'onBeforeUpdate', 'onActivated', 'onDeactivated',
    'onErrorCaptured', 'onRenderTracked', 'onRenderTriggered',
    'onServerPrefetch',
    // 依赖注入
    'provide', 'inject', 'hasInjectionContext',
    // 内置组件名
    'Transition', 'TransitionGroup', 'KeepAlive', 'Teleport', 'Suspense',
    'RouterView', 'RouterLink', 'NuxtLink', 'NuxtPage',
    // 渲染函数 API
    'createApp', 'createSSRApp', 'nextTick', 'mergeProps', 'cloneVNode',
    'resolveComponent', 'resolveDirective', 'withDirectives',
    'renderList', 'renderSlot', 'createSlots', 'openBlock', 'createBlock',
    'createVNode', 'createElementVNode', 'createTextVNode',
    'createCommentVNode', 'createStaticVNode', 'createElementBlock',
    'Fragment', 'Comment', 'Static',
    // Options API 选项名（出现在对象键中）
    'emits', 'components', 'directives', 'mixins', 'extends', 'inject',
    'expose', 'inheritAttrs', 'template', 'render',
    // 常见 Vue 生态全局变量
    'useRouter', 'useRoute', 'usePinia', 'useStore', 'storeToRefs',
    'defineStore', 'acceptHMRUpdate',
]);

/**
 * 合并 HTML 停用词和 Vue 内置停用词
 */
const VUE_STOPWORDS: ReadonlySet<string> = new Set([
    ...HTML_TAG_STOPWORDS,
    ...VUE_BUILTIN_STOPWORDS,
]);

export class VueKeywordExtractor implements LanguageKeywordExtractor {
    extractKeywords(line: string): string[] {
        const stripped = stripStringLiterals(stripLineComment(line, 'vue'));
        const tokens = tokenizeIdentifiers(stripped);
        return baseFilter(tokens, VUE_STOPWORDS);
    }
}
