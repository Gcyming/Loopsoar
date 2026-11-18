# 办公文档读取兼容矩阵

`office_read` 是统一的办公文档文本入口，按文件内容 + 扩展名分派；`docx_read` / `xlsx_read` /
`pdf_read` 保留为兼容别名。它不是 Office 渲染器：只提取可见文本，不还原版面、样式、图片和批注。

## 支持格式

| 格式 | 扩展名 | 读取内容 | 已知边界 |
|---|---|---|---|
| WordprocessingML | `.docx` `.docm` `.dotx` `.dotm` | 正文段落、换行、制表符；表格按单元格制表符展开 | 不读页眉页脚、批注、图片、样式；隐藏文字可能被保留 |
| SpreadsheetML | `.xlsx` `.xlsm` `.xltx` `.xltm` | 默认第一张工作表；可指定 `sheet` 或 `allSheets`；共享/内联字符串、布尔、公式缓存值；常见日期/时间格式还原为 `YYYY-MM-DD[ HH:mm:ss]` | 自定义数字格式只识别日期/时间语义；不读图表/图片/批注；空行可能省略 |
| PresentationML | `.pptx` `.pptm` `.potx` `.potm` `.ppsx` `.ppsm` | 按 presentation rels 顺序读取幻灯片文本、表格文本，并读取关联图表/图示中的标题/分类/数值文本 | 不读备注、图片；图表只取缓存文本，不还原图形/坐标轴样式 |
| OpenDocument 文本 | `.odt` | `content.xml` 的段落/标题文本 | 不读样式、图片、页眉页脚；列表编号可能丢失 |
| OpenDocument 表格 | `.ods` | `content.xml` 的表格单元格/行文本 | 重复列/行不展开，可能丢内容；格式/公式不还原 |
| OpenDocument 演示 | `.odp` | `content.xml` 的页面文本 | 不读备注、图片、动画、图表 |
| OpenDocument 图形 | `.odg` | `content.xml` 的文本对象 | 仅文本，不读图形结构 |
| Flat OpenDocument | `.fodt` `.fods` `.fodp` | 非 ZIP 的 flat XML 正文 | 同对应 ODF 格式 |
| RTF | `.rtf` | 正文、段落、制表符、`\uN`、GBK/ANSI 字节 | 不读图片/嵌入对象/域结果；复杂表格可能退化为文本 |
| CSV / TSV | `.csv` `.tsv` | RFC4180 引号/转义/CRLF、BOM、UTF-16 BOM；无 BOM 时 `encoding:auto` 先 UTF-8，失败回退 GBK/GB18030；输出制表符分隔 | 最多 10,000 行；不推断列类型 |
| PDF | `.pdf` | PDF 文本层，按坐标聚合同行、按字宽补词间距，逐页换行 | 扫描件无文本层时提示 OCR；不还原视觉版面/表格/图片 |
| 旧版二进制 Office | `.doc` `.xls` `.ppt` | `office_read` 直接读取返回另存提示；`office_convert` 用本机 LibreOffice 转 OOXML 后读取 | 需安装 LibreOffice，且该工具声明 terminal 权限；转换只落临时目录 |

## 稳定性边界

- 单文件读取上限 **30 MB**；文本默认截断到 **20,000 字符**（工具参数可调低）。
- ZIP：最多 **4,096** 个条目；单条解压上限 **32 MB**；拒绝加密条目、zip64、未知压缩方法和越界/损坏中央目录；解压时使用 zlib 输出上限防 zip bomb。
- XML：只做实体解码，不加载 DTD/外部实体；非法数字实体降级为替换字符。
- 解析异常统一转成 `[错误] ...` 返回给 Agent，不向工具循环抛异常。
- PDF 逐页 `setImmediate` 让出事件循环，并在达到字符上限后提前停止。

## 使用建议

```text
office_read { path: "D:/docs/方案.docx" }
office_read { path: "D:/docs/数据.xlsx", sheet: "汇总" }
office_read { path: "D:/docs/数据.xlsx", allSheets: true, maxSheets: 20 }
office_read { path: "D:/docs/汇报.pptx", maxSlides: 80 }
office_read { path: "D:/docs/旧版.doc" }   # 返回另存提示，不解析
office_convert { path: "D:/docs/旧版.doc" } # 需 terminal 权限 + 本机 LibreOffice
```

需要视觉版面、图表图形还原或扫描件 OCR 时，先用 Office/LibreOffice 转换或另存，再读取转换后的文件；旧版二进制可直接用 `office_convert`。
