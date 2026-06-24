import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const outputDir = path.resolve("outputs/carbonfiber360");
const csvPath = path.join(outputDir, "carbonfiber360_products.csv");
const xlsxPath = path.join(outputDir, "carbonfiber360_products.xlsx");

const csvText = await fs.readFile(csvPath, "utf8");
const workbook = await Workbook.fromCSV(csvText, { sheetName: "Products" });

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(xlsxPath);

console.log(JSON.stringify({ xlsx: xlsxPath }, null, 2));
