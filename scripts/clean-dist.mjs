/** 清空 tsc 产物目录：tsc 不会删除「源码已删」的旧 .js/.d.ts，必须构建前清一次，避免发布包夹带死代码。 */
import { rmSync } from "node:fs";

const target = process.argv[2] ?? "dist";
rmSync(target, { recursive: true, force: true });
