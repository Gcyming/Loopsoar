/**
 * i18n 死键扫描（P3-1）：先报告，不自动删除。
 *
 * 为什么需要脚本：三份字典（i18n / i18nBrowser / i18nSettings）累计上千个键，
 * 手工 grep 会把动态拼接键（如 settings.nav. 加变量）误报成死键。
 *
 * 规则：
 *   1) 字典键：三份文件里 "key": { zh, en } 的行；
 *   2) 使用处：packages/ui/src 下所有 ts/tsx（排除字典文件本身）中的引号字面量；
 *   3) 动态白名单：DYNAMIC_PREFIXES 里的前缀不计入死键；
 *   4) 输出：完全无引用且不匹配任何动态前缀的键 = 候选死键。
 *
 * 用法：
 *   node scripts/i18n-dead-keys.mjs          # JSON 报告（stdout）
 *   node scripts/i18n-dead-keys.mjs --md     # Markdown 报告（docs/i18n-dead-keys.md）
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const UI_DIR = path.join(ROOT, 'packages/ui/src');
const DICTS = ['i18n.ts', 'i18nBrowser.ts', 'i18nSettings.ts'].map((name) => path.join(UI_DIR, name));

/** 动态键前缀白名单：这些键由模板串/变量拼出来，静态扫描必然误报。 */
const DYNAMIC_PREFIXES = [
  'settings.nav.', // 侧栏导航按 tab id 拼
  'settings.appearance.demo.', // 预览行 1..8
  'settings.appearance.slider.', // 滑块参数名
  'settings.permission.level.', // L0-L5 权限档
  'settings.provider.', // 供应商卡片按字段拼
  'settings.extensions.', // 扩展状态文案按 state 拼
  'settings.memory.category.', // 记忆分类按 category 拼
  'settings.memory.reason.', // 召回理由徽标
  'timeline.', // 时间线工具分类
  'status.', // 状态栏
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

function dictKeys(file) {
  const text = readFileSync(file, 'utf8');
  const keys = [];
  for (const match of text.matchAll(/^\s*"([^"]+)":\s*\{/gm)) keys.push(match[1]);
  return keys;
}

const dictFiles = DICTS.filter((file) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
});
const sources = walk(UI_DIR).filter((file) => !dictFiles.includes(file));
const corpus = sources.map((file) => readFileSync(file, 'utf8')).join('\n');
/** 父级前缀被拼接使用（`browser.${x}` / 'browser.' + x）时，其下所有键都不算死键。 */
function prefixConcatenated(key) {
  const parent = key.includes('.') ? key.slice(0, key.lastIndexOf('.') + 1) : '';
  if (!parent) return false;
  return (
    corpus.includes('`' + parent + '${') ||
    corpus.includes("'" + parent + "' +") ||
    corpus.includes('"' + parent + '" +')
  );
}
const dynamic = (key) =>
  DYNAMIC_PREFIXES.some((prefix) => key.startsWith(prefix)) || prefixConcatenated(key);

const report = [];
for (const file of dictFiles) {
  const keys = dictKeys(file);
  const dead = keys.filter((key) => {
    if (dynamic(key)) return false;
    return !corpus.includes('"' + key + '"') && !corpus.includes("'" + key + "'");
  });
  report.push({ file: path.relative(ROOT, file), total: keys.length, dead: dead.length, keys: dead });
}

const totals = report.reduce((acc, item) => ({ total: acc.total + item.total, dead: acc.dead + item.dead }), { total: 0, dead: 0 });

if (process.argv.includes('--md')) {
  const out = path.join(ROOT, 'docs/i18n-dead-keys.md');
  const lines = [
    '# i18n 死键报告（自动生成，勿手改）',
    '',
    '> 生成时间：' + new Date().toISOString() + '；扫描 ' + sources.length + ' 个 UI 源文件。',
    '> 动态前缀白名单 ' + DYNAMIC_PREFIXES.length + ' 条；命中者不计入死键。',
    '',
    '| 字典 | 键数 | 候选死键 |',
    '| --- | --- | --- |',
    ...report.map((item) => '| `' + item.file + '` | ' + item.total + ' | ' + item.dead + ' |'),
    '',
    '合计：' + totals.total + ' 键，' + totals.dead + ' 个候选死键。删除前必须人工确认（可能被运行时拼接引用）。',
    '',
    ...report.flatMap((item) => [
      '## ' + item.file,
      '',
      ...(item.keys.length ? item.keys.map((key) => '- `' + key + '`') : ['（无）']),
      '',
    ]),
  ];
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, lines.join('\n'), 'utf8');
  console.log('已写入 ' + path.relative(ROOT, out) + '（候选死键 ' + totals.dead + ' / 总键 ' + totals.total + '）');
} else {
  console.log(JSON.stringify({ totals, report }, null, 2));
}