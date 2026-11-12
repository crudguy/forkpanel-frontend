/**
 * 语法高亮的纯函数测试：语言识别、各语言注释规则、以及最重要的
 * 「文本守恒」——着色只是给同一份文本切片，绝不能改动内容本身，
 * 否则编辑框看到的和保存出去的会悄悄不一致。
 */
import { describe, it, expect } from 'vitest'
import { detectLanguage, tokenize, type SyntaxLang } from './syntaxHighlight'

const texts = (src: string, lang: SyntaxLang) =>
  [...tokenize(src, lang).filter((s) => s.c === 'tok-comment')].map((s) => s.t)
const classes = (src: string, lang: SyntaxLang) =>
  new Set(tokenize(src, lang).map((s) => s.c).filter(Boolean))

describe('detectLanguage：显式语言 > 文件名/路径 > 内容特征 > plain', () => {
  it('显式 language 优先于文件名', () => {
    expect(detectLanguage({ language: 'sql', filename: '/etc/nginx/nginx.conf' })).toBe('sql')
    expect(detectLanguage({ language: 'plain', filename: 'a.yml' })).toBe('plain')
  })

  it('按扩展名 / 文件名识别常见配置类型', () => {
    const cases: Array<[string, SyntaxLang]> = [
      ['docker-compose.yml', 'yaml'], ['stack.yaml', 'yaml'], ['a.json', 'json'],
      ['dump.sql', 'sql'], ['run.sh', 'shell'], ['unit.service', 'ini'],
      ['timer.timer', 'ini'], ['settings.ini', 'ini'], ['Cargo.toml', 'ini'],
      ['Dockerfile', 'dockerfile'], ['Dockerfile.prod', 'dockerfile'],
      ['.env', 'env'], ['backup.env', 'env'], ['nginx.conf.nginx', 'nginx'],
    ]
    for (const [filename, want] of cases) {
      expect(detectLanguage({ filename }), filename).toBe(want)
    }
  })

  it('.conf 按路径消歧：站点配置走 nginx，其余（systemd drop-in）走 ini', () => {
    expect(detectLanguage({ filename: '/etc/nginx/sites-enabled/example.conf' })).toBe('nginx')
    expect(detectLanguage({ filename: '/etc/nginx/conf.d/a.conf' })).toBe('nginx')
    expect(detectLanguage({ filename: '/etc/systemd/system/foo.service.d/override.conf' })).toBe('ini')
    expect(detectLanguage({ filename: '/etc/foo.conf' })).toBe('ini')
  })

  it('无文件名时按高置信内容特征兜底，认不出就 plain', () => {
    expect(detectLanguage({ content: '#!/bin/bash\necho 1' })).toBe('shell')
    expect(detectLanguage({ content: '[Service]\nExecStart=/x' })).toBe('ini')
    expect(detectLanguage({ content: 'FROM alpine\nRUN x' })).toBe('dockerfile')
    expect(detectLanguage({ content: '{"a": 1}' })).toBe('json')
    expect(detectLanguage({ content: 'select * from t' })).toBe('sql')
    expect(detectLanguage({ content: 'server {\n  listen 80;\n}' })).toBe('nginx')
    expect(detectLanguage({ content: 'services:\n  web: {}' })).toBe('yaml')
    expect(detectLanguage({ content: 'PORT=80' })).toBe('env')
    expect(detectLanguage({ content: '随便一段文字 # 也不是注释' })).toBe('plain')
    expect(detectLanguage({})).toBe('plain')
  })
})

describe('tokenize：各语言注释与关键 token', () => {
  it('nginx：整行 / 行尾 / 方括号紧贴的 # 注释，字符串内的 # 不误判', () => {
    const src = '# whole\nlisten 80; # tail\n#[anchor] 80\nset $x "a # b";'
    expect(texts(src, 'nginx')).toEqual(['# whole', '# tail', '#[anchor] 80'])
    const all = tokenize(src, 'nginx')
    expect(all.filter((s) => s.c === 'tok-string').map((s) => s.t)).toEqual(['"a # b"'])
    expect(all.filter((s) => s.c === 'tok-var').map((s) => s.t)).toEqual(['$x'])
    expect(all.filter((s) => s.c === 'tok-directive').map((s) => s.t)).toEqual(['listen', 'set'])
    expect(all.filter((s) => s.c === 'tok-num').map((s) => s.t)).toEqual(['80'])
  })

  it('yaml：# 注释到行尾，键与字符串各自着色', () => {
    const src = 'version: "3"\nservices:\n  # note\n  image: nginx # c\n'
    expect(texts(src, 'yaml')).toEqual(['# note', '# c'])
    expect(tokenize(src, 'yaml').filter((s) => s.c === 'tok-var').map((s) => s.t))
      .toEqual(['version', 'services', 'image'])
    expect(tokenize(src, 'yaml').filter((s) => s.c === 'tok-string').map((s) => s.t)).toEqual(['"3"'])
  })

  it('sql：-- 与 /* */ 注释、字符串里的 -- 不误判、关键字大小写不敏感', () => {
    const src = "SELECT * FROM t WHERE id = 1; -- hi\n/* block */ insert into t values ('a -- b')"
    expect(texts(src, 'sql')).toEqual(['-- hi', '/* block */'])
    expect(tokenize(src, 'sql').filter((s) => s.c === 'tok-string').map((s) => s.t)).toEqual(["'a -- b'"])
    expect(tokenize(src, 'sql').filter((s) => s.c === 'tok-directive').map((s) => s.t))
      .toEqual(['SELECT', 'FROM', 'WHERE', 'insert', 'into', 'values'])
  })

  it('ini / env：; 与 # 注释、节名、KEY=、数字', () => {
    const ini = '[Service]\nExecStart=/usr/bin/x\n; note\n# hash\nTimeout=30'
    expect(texts(ini, 'ini')).toEqual(['; note', '# hash'])
    expect(tokenize(ini, 'ini').filter((s) => s.c === 'tok-directive').map((s) => s.t)).toEqual(['[Service]'])
    expect(tokenize(ini, 'ini').filter((s) => s.c === 'tok-var').map((s) => s.t))
      .toEqual(['ExecStart', 'Timeout'])

    const env = '# c\nTZ=Asia/Shanghai\nPORT=80'
    expect(texts(env, 'env')).toEqual(['# c'])
    expect(tokenize(env, 'env').filter((s) => s.c === 'tok-var').map((s) => s.t)).toEqual(['TZ', 'PORT'])
  })

  it('json / shell / dockerfile：各自注释或指令规则独立生效', () => {
    const json = '{"name": "x", "n": 12, "ok": true}'
    expect(texts(json, 'json')).toEqual([])
    expect(tokenize(json, 'json').filter((s) => s.c === 'tok-var').map((s) => s.t))
      .toEqual(['"name"', '"n"', '"ok"'])

    const sh = '#!/bin/bash\n# c\necho $HOME ${X}'
    expect(texts(sh, 'shell')).toEqual(['#!/bin/bash', '# c'])
    expect(tokenize(sh, 'shell').filter((s) => s.c === 'tok-var').map((s) => s.t)).toEqual(['$HOME', '${X}'])

    const df = '# c\nFROM alpine:3.19\nRUN echo $X'
    expect(texts(df, 'dockerfile')).toEqual(['# c'])
    expect(tokenize(df, 'dockerfile').filter((s) => s.c === 'tok-directive').map((s) => s.t))
      .toEqual(['FROM', 'RUN'])
    expect(tokenize(df, 'dockerfile').filter((s) => s.c === 'tok-var').map((s) => s.t)).toEqual(['$X'])
  })

  it('plain 只返回一段原文，不产生任何 class', () => {
    const src = 'anything # not a comment\n<tag> & 123\n'
    expect(tokenize(src, 'plain')).toEqual([{ t: src }])
    expect(tokenize('', 'plain')).toEqual([])
  })

  it('所有语言都只产出已登记的 6 种 token class（分组索引不能错位）', () => {
    const valid = new Set(['tok-string', 'tok-comment', 'tok-var', 'tok-directive', 'tok-num', 'tok-punc'])
    const langs: SyntaxLang[] = ['nginx', 'yaml', 'sql', 'ini', 'env', 'json', 'shell', 'dockerfile']
    for (const lang of langs) {
      const got = classes('key: 1 # c "s" $x [x] 80', lang)
      expect(got.size, `${lang} 没有任何 token 被着色`).toBeGreaterThan(0)
      for (const c of got) expect(valid.has(c!), `${lang} 出现未知 class ${c}`).toBe(true)
    }
  })

  it('文本守恒：切片拼回去与原文一致（末尾换行补一个对齐空格）', () => {
    const langs: SyntaxLang[] = ['plain', 'nginx', 'yaml', 'sql', 'ini', 'env', 'json', 'shell', 'dockerfile']
    const samples = [
      '# c\nlisten 80;',
      'version: "3"\nservices:\n  web: {}',
      'SELECT 1; -- x\n',
      '[Service]\nExecStart=/x\n',
      'a\nb\n',
      '',
    ]
    for (const lang of langs) {
      for (const src of samples) {
        const joined = tokenize(src, lang).map((s) => s.t).join('')
        expect(joined, `${lang} / ${JSON.stringify(src)}`).toBe(src.endsWith('\n') && lang !== 'plain' ? src + ' ' : src)
      }
    }
  })
})
