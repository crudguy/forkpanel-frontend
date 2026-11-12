/**
 * 文本编辑框的轻量语法高亮：文件类型识别 + tokenizer。
 *
 * 为什么是纯模块：LinedTextarea（通用文本框）与 NginxEditor（站点配置）都需要
 * 同一套着色规则；规则写在组件里就会出现「一处修了、另一处没修」的分叉。
 * 这里只产出文本段，不含任何 DOM / Vue 依赖，着色层由各组件自己渲染。
 *
 * 语义是近似匹配（值关键字也可能被当指令上色），对配置编辑足够，零运行时依赖。
 * 规则用有序捕获组实现「先到先得」：字符串必须排在注释前，否则引号内的 # 会
 * 被吞成注释。规则内部一律用非捕获组 (?:...)，否则分组索引会错位。
 */

export type SyntaxLang =
  | 'nginx' | 'yaml' | 'sql' | 'ini' | 'env' | 'json' | 'shell' | 'dockerfile' | 'plain'

export interface Seg { t: string; c?: string }

type TokClass = 'tok-string' | 'tok-comment' | 'tok-var' | 'tok-directive' | 'tok-num' | 'tok-punc'
interface Rule { cls: TokClass; re: string }

const S = String.raw
const QUOTED = S`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`
const SHELL_VAR = S`\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*`
const NUMBER = S`\b\d+(?:\.\d+){3}\b|\b\d+(?:\.\d+)?\b`

/** 关键字大小写不敏感；其余语言保持原样，避免改变既有 nginx 规则的大小写行为。 */
const FLAGS: Partial<Record<SyntaxLang, string>> = { sql: 'i', dockerfile: 'i' }

const RULES: Record<SyntaxLang, Rule[]> = {
  plain: [],
  nginx: [
    { cls: 'tok-string', re: QUOTED },
    // 必须是字符类 `[^\n]*`：写成 `\[` 会退化成「字面 [ + 行首断言 + 换行」，
    // 整条分支恒不命中，着色层永远不出现 .tok-comment。
    { cls: 'tok-comment', re: S`#[^\n]*` },
    { cls: 'tok-var', re: S`\$[A-Za-z_][A-Za-z0-9_]*` },
    { cls: 'tok-directive', re: S`[A-Za-z_][A-Za-z0-9_]*(?=[\s;{])` },
    { cls: 'tok-num', re: NUMBER },
    { cls: 'tok-punc', re: S`[{};]` },
  ],
  yaml: [
    { cls: 'tok-string', re: QUOTED },
    { cls: 'tok-comment', re: S`#[^\n]*` },
    { cls: 'tok-var', re: S`[\w.-]+(?=[ \t]*:)` },
    { cls: 'tok-directive', re: S`\b(?:true|false|null|yes|no|on|off)\b` },
    { cls: 'tok-num', re: S`\b\d+(?:\.\d+)?\b` },
    { cls: 'tok-punc', re: S`[{}\[\],:|-]` },
  ],
  sql: [
    { cls: 'tok-string', re: S`'(?:[^']|'')*'|"(?:[^"\\]|\\.)*"` },
    { cls: 'tok-comment', re: S`--[^\n]*|/\*[\s\S]*?\*/` },
    { cls: 'tok-var', re: S`[@:][A-Za-z_][A-Za-z0-9_]*` },
    { cls: 'tok-directive', re: S`\b(?:select|from|where|insert|into|values|update|set|delete|create|table|drop|alter|join|left|right|inner|outer|on|group|by|order|having|limit|offset|as|and|or|not|null|is|in|like|distinct|union|with|explain|pragma|begin|commit|rollback|case|when|then|else|end|count|sum|avg|min|max)\b` },
    { cls: 'tok-num', re: S`\b\d+(?:\.\d+)?\b` },
    { cls: 'tok-punc', re: S`[(),;*]` },
  ],
  ini: [
    { cls: 'tok-string', re: QUOTED },
    { cls: 'tok-comment', re: S`(?:;|#)[^\n]*` },
    { cls: 'tok-directive', re: S`\[[^\]\n]+\]` },
    { cls: 'tok-var', re: S`[\w.-]+(?=[ \t]*=)` },
    { cls: 'tok-num', re: S`\b\d+(?:\.\d+)?\b` },
    { cls: 'tok-punc', re: S`[={}\[\]]` },
  ],
  env: [
    { cls: 'tok-string', re: QUOTED },
    { cls: 'tok-comment', re: S`#[^\n]*` },
    { cls: 'tok-var', re: S`[A-Za-z_][A-Za-z0-9_]*(?==)` },
    { cls: 'tok-num', re: S`\b\d+(?:\.\d+)?\b` },
    { cls: 'tok-punc', re: S`=` },
  ],
  json: [
    // 键要先于普通字符串：否则 `"a": 1` 的键会被后面的字符串规则整段吃掉。
    { cls: 'tok-var', re: S`"(?:[^"\\]|\\.)*"(?=\s*:)` },
    { cls: 'tok-string', re: S`"(?:[^"\\]|\\.)*"` },
    { cls: 'tok-directive', re: S`\b(?:true|false|null)\b` },
    { cls: 'tok-num', re: S`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b` },
    { cls: 'tok-punc', re: S`[{}\[\],:]` },
  ],
  shell: [
    { cls: 'tok-string', re: QUOTED },
    { cls: 'tok-comment', re: S`#[^\n]*` },
    { cls: 'tok-var', re: SHELL_VAR },
    { cls: 'tok-directive', re: S`\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|return|export|local|source|echo|cd|set|exit)\b` },
    { cls: 'tok-num', re: S`\b\d+(?:\.\d+)?\b` },
    { cls: 'tok-punc', re: S`[|&;(){}<>]` },
  ],
  dockerfile: [
    { cls: 'tok-string', re: QUOTED },
    { cls: 'tok-comment', re: S`#[^\n]*` },
    { cls: 'tok-var', re: SHELL_VAR },
    { cls: 'tok-directive', re: S`\b(?:from|run|cmd|label|maintainer|expose|env|add|copy|entrypoint|volume|user|workdir|arg|onbuild|stopsignal|healthcheck|shell)\b` },
    { cls: 'tok-num', re: S`\b\d+(?:\.\d+)?\b` },
    { cls: 'tok-punc', re: S`[{}\[\],:=]` },
  ],
}

/** 无文件名时的兜底：只认高置信特征，识别不出就 plain（宁可不着色，也不乱上色）。 */
function sniff(content: string): SyntaxLang {
  const head = content.slice(0, 4096)
  if (/^\s*#!/.test(head)) return 'shell'
  if (/^\s*\[(?:Service|Unit|Install|Socket|Timer|Mount)\]/m.test(head)) return 'ini'
  if (/^\s*(?:FROM|RUN|CMD|ENTRYPOINT)\s+/m.test(head)) return 'dockerfile'
  if (/^\s*\{\s*"[\w-]+"\s*:/.test(head)) return 'json'
  if (/\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|PRAGMA|WITH)\b/i.test(head)) return 'sql'
  if (/^\s*(?:server|http|events|location|upstream)\s*\{/m.test(head)) return 'nginx'
  if (/^\s*[\w.-]+\s*:/m.test(head)) return 'yaml'
  if (/^\s*[A-Z_][A-Z0-9_]*=/m.test(head)) return 'env'
  return 'plain'
}

/**
 * 显式 language > 文件名/路径 > 内容特征 > plain。
 * `.conf` 单独消歧：只有路径含 nginx / sites-* / vhost 才按 nginx 着色，
 * 其余（systemd drop-in、通用配置）走 ini，避免把 [Service] 当 nginx 指令。
 */
export function detectLanguage(opts: { filename?: string; language?: SyntaxLang; content?: string } = {}): SyntaxLang {
  if (opts.language) return opts.language
  const path = (opts.filename ?? '').trim().toLowerCase().replace(/\\/g, '/')
  const name = path.split('/').pop() ?? ''
  if (/^dockerfile(?:\.|$)/.test(name)) return 'dockerfile'
  if (name === '.env' || /\.env(?:\.|$)/.test(name)) return 'env'
  const ext = name.includes('.') ? (name.split('.').pop() ?? '') : ''
  switch (ext) {
    case 'yml': case 'yaml': return 'yaml'
    case 'json': return 'json'
    case 'sql': return 'sql'
    case 'sh': case 'bash': case 'zsh': case 'ksh': return 'shell'
    case 'service': case 'timer': case 'socket': case 'target': case 'mount':
    case 'slice': case 'ini': case 'toml': return 'ini'
    case 'nginx': return 'nginx'
    case 'conf': return /nginx|sites-(?:available|enabled)|vhost/.test(path) ? 'nginx' : 'ini'
  }
  return sniff(opts.content ?? '')
}

const COMPILED = new Map<SyntaxLang, RegExp>()

function compiled(lang: SyntaxLang): RegExp {
  let re = COMPILED.get(lang)
  if (!re) {
    re = new RegExp(RULES[lang].map((r) => `(${r.re})`).join('|'), 'g' + (FLAGS[lang] ?? ''))
    COMPILED.set(lang, re)
  }
  return re
}

/**
 * 把整段文本切成着色片段。plain 只返回一段原文（不产生任何 span），
 * 保证未识别文件类型的编辑、选中、复制与保存链路完全不变。
 * 末尾换行补一个空格：textarea 会多渲染一个空行，pre 需对齐高度。
 */
export function tokenize(src: string, lang: SyntaxLang = 'plain'): Seg[] {
  if (lang === 'plain' || src === '') return src === '' ? [] : [{ t: src }]
  const rules = RULES[lang]
  const re = compiled(lang)
  re.lastIndex = 0
  const segs: Seg[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (m.index > last) segs.push({ t: src.slice(last, m.index) })
    const gi = m.slice(1).findIndex((v) => v !== undefined)
    segs.push({ t: m[0], c: rules[gi]?.cls ?? '' })
    last = m.index + m[0].length
  }
  if (last < src.length) segs.push({ t: src.slice(last) })
  if (src.endsWith('\n')) segs.push({ t: ' ' })
  return segs
}
