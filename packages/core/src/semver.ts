/**
 * 最小 SemVer 2.0 实现（纯逻辑，零依赖）。
 *
 * 为什么自己写而不引入 `semver`：
 *   · 插件清单校验发生在 core（不能依赖 shell 的 node_modules 布局）；
 *   · 只需要 parse / compare / satisfies 三件事，npm 包的体量与攻击面远大于收益；
 *   · 行为必须可单测、可解释（版本协商是安装门禁，不能「大概对」）。
 *
 * 支持的范围语法（覆盖插件生态实际会写的形态）：
 *   · 精确：1.2.3 / =1.2.3
 *   · 比较：>=1.2.3 >1.2 <=2 <2.0.0
 *   · 脱字符：^1.2.3（0.x 按 npm 规则收紧）
 *   · 波浪号：~1.2.3 / ~1.2 / ~1
 *   · 通配：* / x / 1.x / 1.2.x / 1.*
 *   · 连字符：1.2.3 - 2.3.4
 *   · 或：^1.0.0 || ^2.0.0；与：空格分隔
 *
 * 预发布语义遵循 npm：默认不允许预发布版本命中普通范围；只有同一
 * major.minor.patch 的比较器显式带预发布标签时才放行。
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
  build: string[];
  raw: string;
}

export type SemVerComparatorOperator = "=" | ">" | ">=" | "<" | "<=";

export interface SemVerComparator {
  operator: SemVerComparatorOperator;
  version: SemVer;
}

/** 单个「与」组；组内所有比较器必须同时满足。 */
export interface SemVerRangeSet {
  raw: string;
  comparators: SemVerComparator[];
  /** 显式带预发布标签的比较器版本（npm 预发布放行规则用）。 */
  prereleaseBases: string[];
}

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const PARTIAL_RE =
  /^(0|[1-9]\d*|[xX*])(?:\.(0|[1-9]\d*|[xX*]))?(?:\.(0|[1-9]\d*|[xX*]))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function isNumericIdentifier(value: string): boolean {
  return /^\d+$/.test(value);
}

function normalizePrerelease(raw: string | undefined): Array<string | number> {
  if (!raw) return [];
  return raw.split(".").map((part) => {
    // 数字标识不得有前导零（SemVer §9）；这里保留为字符串但标记为非法由 parse 拒绝。
    return isNumericIdentifier(part) ? Number(part) : part;
  });
}

/**
 * 解析完整版本。非法输入返回 null（不抛错：清单校验需要把原因写进报告）。
 */
export function parseSemVer(input: string): SemVer | null {
  const raw = input.trim();
  const match = SEMVER_RE.exec(raw);
  if (!match) return null;
  const [, major, minor, patch, prerelease, build] = match;
  const preParts = prerelease ? prerelease.split(".") : [];
  // 数字预发布标识禁止前导零（01 非法）；字母数字标识允许。
  for (const part of preParts) {
    if (isNumericIdentifier(part) && part.length > 1 && part.startsWith("0")) return null;
  }
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: normalizePrerelease(prerelease),
    build: build ? build.split(".") : [],
    raw,
  };
}

export function isValidSemVer(input: string): boolean {
  return parseSemVer(input) !== null;
}

function comparePrerelease(a: Array<string | number>, b: Array<string | number>): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // 正式版 > 预发布
  if (b.length === 0) return -1;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNumeric = typeof left === "number";
    const rightNumeric = typeof right === "number";
    if (leftNumeric && rightNumeric) return left < right ? -1 : 1;
    if (leftNumeric) return -1; // 数字标识优先级低于字母数字
    if (rightNumeric) return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

/** SemVer 优先级比较（忽略 build metadata）。 */
export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function compareVersionStrings(a: string, b: string): number | null {
  const left = parseSemVer(a);
  const right = parseSemVer(b);
  if (!left || !right) return null;
  return compareSemVer(left, right);
}

/** 具体版本字符串是否等于另一个（忽略 build）。 */
export function semverEquals(a: SemVer, b: SemVer): boolean {
  return compareSemVer(a, b) === 0;
}

function makeVersion(major: number, minor: number, patch: number): SemVer {
  return { major, minor, patch, prerelease: [], build: [], raw: `${major}.${minor}.${patch}` };
}

interface PartialVersion {
  major: number | null;
  minor: number | null;
  patch: number | null;
  prerelease: Array<string | number>;
  bounded: boolean;
}

function parsePartial(input: string): PartialVersion | null {
  const match = PARTIAL_RE.exec(input.trim());
  if (!match) return null;
  const [, majorRaw, minorRaw, patchRaw, prerelease] = match;
  const parsePart = (value: string | undefined): number | null | "wildcard" => {
    if (value === undefined) return null;
    if (value === "x" || value === "X" || value === "*") return "wildcard";
    return Number(value);
  };
  const major = parsePart(majorRaw);
  const minor = parsePart(minorRaw);
  const patch = parsePart(patchRaw);
  if (major === "wildcard" && ((minor !== null && minor !== "wildcard") || (patch !== null && patch !== "wildcard"))) {
    return null; // x.2.3 不是合法范围
  }
  if (major === "wildcard" || minor === "wildcard" || patch === "wildcard") {
    return {
      major: major === "wildcard" ? null : major,
      minor: minor === "wildcard" ? null : minor,
      patch: patch === "wildcard" ? null : patch,
      prerelease: [],
      bounded: false,
    };
  }
  // 一旦低位出现通配，后续位必须视为未指定（1.x.3 按 1.x 处理）。
  return {
    major,
    minor,
    patch,
    prerelease: normalizePrerelease(prerelease),
    bounded: true,
  };
}

/** 把部分版本补成下界版本（1.2 → 1.2.0）。 */
function partialFloor(part: PartialVersion): SemVer {
  return makeVersion(part.major ?? 0, part.minor ?? 0, part.patch ?? 0);
}

/** 按位递增出「下一个」版本，用于 `<` 上界。 */
function nextAt(depth: 0 | 1 | 2, version: SemVer): SemVer {
  if (depth === 0) return makeVersion(version.major + 1, 0, 0);
  if (depth === 1) return makeVersion(version.major, version.minor + 1, 0);
  return makeVersion(version.major, version.minor, version.patch + 1);
}

function comparatorsFor(operator: string, part: PartialVersion): SemVerComparator[] {
  const floor = partialFloor(part);
  const specified = part.patch !== null ? 2 : part.minor !== null ? 1 : 0;
  switch (operator) {
    case "=":
      if (part.patch !== null) {
        return [{ operator: "=", version: { ...floor, prerelease: part.prerelease, raw: floor.raw } }];
      }
      return [
        { operator: ">=", version: floor },
        { operator: "<", version: nextAt(specified === 1 ? 1 : 0, floor) },
      ];
    case ">=":
      return [{ operator: ">=", version: { ...floor, prerelease: part.prerelease, raw: floor.raw } }];
    case ">":
      if (part.patch !== null) return [{ operator: ">", version: { ...floor, prerelease: part.prerelease, raw: floor.raw } }];
      return [{ operator: ">=", version: nextAt(specified === 1 ? 1 : 0, floor) }];
    case "<":
      return [{ operator: "<", version: floor }];
    case "<=":
      if (part.patch !== null) return [{ operator: "<=", version: { ...floor, prerelease: part.prerelease, raw: floor.raw } }];
      return [{ operator: "<", version: nextAt(specified === 1 ? 1 : 0, floor) }];
    case "^": {
      if (floor.major > 0) return [{ operator: ">=", version: floor }, { operator: "<", version: nextAt(0, floor) }];
      if (floor.minor > 0) return [{ operator: ">=", version: floor }, { operator: "<", version: nextAt(1, floor) }];
      if (part.patch !== null) return [{ operator: ">=", version: floor }, { operator: "<", version: nextAt(2, floor) }];
      if (part.minor !== null) return [{ operator: ">=", version: floor }, { operator: "<", version: nextAt(1, floor) }];
      return [{ operator: ">=", version: floor }, { operator: "<", version: nextAt(0, floor) }];
    }
    case "~": {
      if (part.minor !== null) return [{ operator: ">=", version: floor }, { operator: "<", version: nextAt(1, floor) }];
      return [{ operator: ">=", version: floor }, { operator: "<", version: nextAt(0, floor) }];
    }
    default:
      return [];
  }
}

/**
 * 解析一个「与」组（空格分隔的比较器 + 连字符范围）。空组表示 *。
 * 返回 null 表示语法非法（调用方必须 fail-closed）。
 */
export function parseRangeSet(input: string): SemVerRangeSet | null {
  const raw = input.trim();
  if (raw === "" || raw === "*" || raw === "x" || raw === "X") {
    return { raw, comparators: [], prereleaseBases: [] };
  }

  const hyphen = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(raw);
  if (hyphen) {
    const lower = parsePartial(hyphen[1]);
    const upper = parsePartial(hyphen[2]);
    if (!lower || !upper) return null;
    const comparators: SemVerComparator[] = [];
    const lowerVersion = partialFloor(lower);
    comparators.push({ operator: ">=", version: { ...lowerVersion, prerelease: lower.prerelease, raw: lowerVersion.raw } });
    if (upper.patch !== null) {
      const upperVersion = { ...partialFloor(upper), prerelease: upper.prerelease, raw: partialFloor(upper).raw };
      comparators.push({ operator: "<=", version: upperVersion });
    } else {
      comparators.push({ operator: "<", version: nextAt(upper.minor !== null ? 1 : 0, partialFloor(upper)) });
    }
    return {
      raw,
      comparators,
      prereleaseBases: [lower, upper]
        .filter((item) => item.prerelease.length > 0)
        .map((item) => `${item.major}.${item.minor}.${item.patch}`),
    };
  }

  const tokens = raw.split(/\s+/).filter(Boolean);
  const comparators: SemVerComparator[] = [];
  const prereleaseBases: string[] = [];
  for (const token of tokens) {
    if (token === "*" || token === "x" || token === "X") continue;
    const match = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(token);
    if (!match) return null;
    const operator = match[1] ?? "=";
    const body = match[2];
    if (!body) return null;
    const part = parsePartial(body);
    if (!part) return null;
    // 1.x / 1.2.x：没有具体上界，按「该前缀的所有版本」展开。
    if (!part.bounded) {
      const floor = partialFloor(part);
      const depth = part.minor === null ? 0 : 1;
      comparators.push({ operator: ">=", version: floor });
      comparators.push({ operator: "<", version: nextAt(depth as 0 | 1, floor) });
      continue;
    }
    const expanded = comparatorsFor(operator, part);
    if (expanded.length === 0) return null;
    for (const comparator of expanded) comparators.push(comparator);
    if (part.prerelease.length > 0) {
      prereleaseBases.push(`${part.major}.${part.minor}.${part.patch}`);
    }
  }
  return { raw, comparators, prereleaseBases };
}

function inRangeSet(version: SemVer, set: SemVerRangeSet): boolean {
  if (version.prerelease.length > 0) {
    const base = `${version.major}.${version.minor}.${version.patch}`;
    if (!set.prereleaseBases.includes(base)) return false;
  }
  return set.comparators.every((comparator) => {
    const result = compareSemVer(version, comparator.version);
    switch (comparator.operator) {
      case "=":
        return result === 0;
      case ">":
        return result > 0;
      case ">=":
        return result >= 0;
      case "<":
        return result < 0;
      case "<=":
        return result <= 0;
      default:
        return false;
    }
  });
}

/**
 * version 是否满足范围。非法 version / range 一律返回 false（fail-closed）。
 * 多个「与」组用 `||` 分隔，命中任意一组即通过。
 */
export function satisfies(version: string, range: string): boolean {
  const parsed = parseSemVer(version);
  if (!parsed) return false;
  const groups = range.split("||");
  if (groups.length === 0) return false;
  for (const group of groups) {
    const set = parseRangeSet(group);
    if (!set) continue;
    if (inRangeSet(parsed, set)) return true;
  }
  return false;
}

/** 范围语法是否合法（空范围 = *，合法）。 */
export function isValidRange(range: string): boolean {
  if (typeof range !== "string") return false;
  const groups = range.split("||");
  if (groups.length === 0) return false;
  return groups.every((group) => parseRangeSet(group) !== null);
}

/** 取满足范围的最大版本（用于市场「最新版」判定；无命中返回 null）。 */
export function maxSatisfying(versions: readonly string[], range: string): string | null {
  let best: { raw: string; parsed: SemVer } | null = null;
  for (const raw of versions) {
    const parsed = parseSemVer(raw);
    if (!parsed || !satisfies(raw, range)) continue;
    if (!best || compareSemVer(parsed, best.parsed) > 0) best = { raw, parsed };
  }
  return best?.raw ?? null;
}
