/**
 * 生成入口：只负责调用纯生成函数，避免 gen.ts 被 import 时产生写盘副作用。
 * 用法：pnpm --filter loopsoar-contracts gen
 */
import {
  generateIpcManifest,
  generateIpcTs,
  generateSecurityPolicyJson,
} from "./gen.ts";

generateIpcManifest();
generateIpcTs();
generateSecurityPolicyJson();
console.log("生成完成。生成物已入库（gen/ 目录）。");
