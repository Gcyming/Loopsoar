/**
 * 渲染期守卫：禁止在提前 return 之后、或条件/循环/逻辑表达式内部调用 hook。
 *
 * 背景：React #310「Rendered more hooks than during the previous render」会让整棵组件树
 * 卸载，用户看到的就是「黑屏」。RefPanel 曾因 useState 写在 `if (files.length === 0) return null`
 * 之后，Agent 第一次读到文件就触发。这条测试用 TS AST 静态扫描 UI 源码，防止同类问题再进来。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const requireFromRoot = createRequire(path.join(process.cwd(), "package.json"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ts: any = requireFromRoot("typescript");

interface Finding {
  file: string;
  line: number;
  fn: string;
  hook: string;
  kind: string;
}

const HOOK_RE = /^use[A-Z0-9]/;

function hookName(call: any): string | null {
  const callee = call.expression;
  if (!callee) return null;
  if (ts.isIdentifier(callee) && HOOK_RE.test(callee.text)) return callee.text;
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "React" &&
    HOOK_RE.test(callee.name.text)
  ) {
    return `React.${callee.name.text}`;
  }
  return null;
}

function isFunctionNode(node: any): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function functionName(node: any): string {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  if (ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  return "";
}

/** 只收集属于当前函数的 hook（遇到嵌套函数就停）。 */
function collectHooks(node: any, out: { hook: string; call: any }[]): void {
  for (const child of node.getChildren()) {
    if (isFunctionNode(child)) continue;
    if (ts.isCallExpression(child)) {
      const hook = hookName(child);
      if (hook) out.push({ hook, call: child });
    }
    collectHooks(child, out);
  }
}

function collectReturns(node: any, out: any[]): void {
  for (const child of node.getChildren()) {
    if (isFunctionNode(child)) continue;
    if (ts.isReturnStatement(child)) out.push(child);
    collectReturns(child, out);
  }
}

function scan(root: string): { findings: Finding[]; files: number } {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".tsx") || ent.name.endsWith(".ts")) files.push(p);
    }
  };
  walk(root);

  const findings: Finding[] = [];
  for (const file of files) {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: any): void => {
      if (isFunctionNode(node)) {
        const fn = functionName(node);
        const shouldCheck = /^[A-Z]/.test(fn) || /^use[A-Z0-9]/.test(fn);
        if (shouldCheck && node.body) {
          const hooks: { hook: string; call: any }[] = [];
          collectHooks(node.body, hooks);
          const returns: any[] = [];
          collectReturns(node.body, returns);
          for (const { hook, call } of hooks) {
            const line = sf.getLineAndCharacterOfPosition(call.getStart()).line + 1;
            let parent = call.parent;
            let conditional = "";
            while (parent && parent !== node) {
              if (
                ts.isIfStatement(parent) ||
                ts.isForStatement(parent) ||
                ts.isForOfStatement(parent) ||
                ts.isWhileStatement(parent) ||
                ts.isDoStatement(parent) ||
                ts.isSwitchStatement(parent) ||
                ts.isConditionalExpression(parent)
              ) {
                conditional = ts.SyntaxKind[parent.kind];
                break;
              }
              if (
                ts.isBinaryExpression(parent) &&
                [
                  ts.SyntaxKind.AmpersandAmpersandToken,
                  ts.SyntaxKind.BarBarToken,
                  ts.SyntaxKind.QuestionQuestionToken,
                ].includes(parent.operatorToken.kind)
              ) {
                conditional = "Logical";
                break;
              }
              parent = parent.parent;
            }
            if (conditional) findings.push({ file: path.relative(root, file), line, fn, hook, kind: `inside-${conditional}` });
            // return 包住 hook 本身（return useX(...)）不算「提前 return」。
            const early = returns.find(
              (r) =>
                r.getStart() < call.getStart() &&
                !(r.expression && call.getStart() >= r.expression.getStart() && call.getEnd() <= r.expression.getEnd()),
            );
            if (early) {
              findings.push({
                file: path.relative(root, file),
                line,
                fn,
                hook,
                kind: `after-return@${sf.getLineAndCharacterOfPosition(early.getStart()).line + 1}`,
              });
            }
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(sf);
  }
  return { findings, files: files.length };
}

describe("hooks order guard", () => {
  it("UI 组件/自定义 hook 不在条件内或提前 return 之后调用 hook", () => {
    const { findings, files } = scan(path.resolve(process.cwd(), "packages/ui/src"));
    expect(files).toBeGreaterThan(50);
    const detail = findings.map((f) => `${f.file}:${f.line} [${f.fn}] ${f.hook} ${f.kind}`).join("\n");
    expect(detail).toBe("");
  });
});
