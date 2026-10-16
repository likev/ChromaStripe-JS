/**
 * Simulation report formatter and writer.
 */

import fs from 'node:fs';
import path from 'node:path';

export function writeReport(fileName, markdownContent) {
  const reportsDir = path.resolve('reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const outPath = path.join(reportsDir, fileName);
  fs.writeFileSync(outPath, markdownContent, 'utf8');
  console.log(`[Report] Generated ${outPath}`);
}
