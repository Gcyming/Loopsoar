/**
 * 品牌单一产地（APP_NAME / APP_ID / 数据目录名 / 协议 / session 分区）。
 * shell 内唯一权威来源；其他模块不得独立定义同类常量。
 */
export const APP_NAME = "Loopsoar";
export const APP_ID = "com.loopsoar.app";
/** 程序版本单一产地：内测阶段使用 0.0.x；发布到 0.1.0 前均不算公开稳定版。 */
export const APP_VERSION = "0.0.1";
export const DATA_DIR_NAME = "loopsoar";
export const PROTOCOL = "loopsoar";
export const SESSION_PARTITION = "persist:loopsoar-browser";
