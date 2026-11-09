/**
 * 一次性工具：把 slime 的 MODEL_CAPABILITIES 抽成 Loopsoar 可用的 JSON
 * （只保留能力/上下文/输出/端点/思考协议字段，不搬定价）。
 */
import fs from "node:fs";

async function main() {
  const mod = (await import("file:///D:/pilot%20project/shared/gen/model-capabilities.ts")) as {
    MODEL_CAPABILITIES: Array<{
      key: string;
      label: string;
      context?: number;
      maxOut?: number;
      models: Array<{
        match: string;
        thinking: boolean;
        efforts?: string[];
        context?: number;
        maxOut?: number;
        endpoint?: string;
        thinkingParam?: string;
      }>;
    }>;
  };
  const vendors = mod.MODEL_CAPABILITIES.map((v) => ({
    key: v.key,
    label: v.label,
    ...(v.context !== undefined ? { context: v.context } : {}),
    ...(v.maxOut !== undefined ? { maxOut: v.maxOut } : {}),
    models: v.models.map((m) => ({
      match: m.match,
      thinking: m.thinking,
      ...(m.efforts && m.efforts.length > 0 ? { efforts: m.efforts } : {}),
      ...(m.context !== undefined ? { context: m.context } : {}),
      ...(m.maxOut !== undefined ? { maxOut: m.maxOut } : {}),
      ...(m.endpoint ? { endpoint: m.endpoint } : {}),
      ...(m.thinkingParam ? { thinkingParam: m.thinkingParam } : {}),
    })),
  }));
  const outPath = "../e2e-evidence/slime-model-capabilities.json";
  fs.writeFileSync(outPath, JSON.stringify(vendors, null, 2));
  console.log(
    "vendors",
    vendors.length,
    "models",
    vendors.reduce((n, v) => n + v.models.length, 0),
  );
  console.log("written", outPath);
}

void main();
