/**
 * Dependency-free SVG chart generator for simulation reports.
 */

/**
 * Generates an SVG line/scatter plot.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.xLabel
 * @param {string} options.yLabel
 * @param {Array<{ label: string, color: string, points: Array<[number, number]> }>} options.series
 * @param {number} [options.width=600]
 * @param {number} [options.height=400]
 * @returns {string} SVG markup string
 */
export function generateSvgPlot(options) {
  const width = options.width || 600;
  const height = options.height || 400;
  const margin = { top: 40, right: 30, bottom: 50, left: 60 };

  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;

  for (const s of options.series) {
    for (const [x, y] of s.points) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (minX === maxX) { minX -= 1; maxX += 1; }
  if (minY === maxY) { minY -= 1; maxY += 1; }

  const scaleX = (x) => margin.left + ((x - minX) / (maxX - minX)) * plotW;
  const scaleY = (y) => margin.top + plotH - ((y - minY) / (maxY - minY)) * plotH;

  let linesSvg = '';
  let legendSvg = '';

  options.series.forEach((s, idx) => {
    const color = s.color || '#3b82f6';
    if (s.points.length > 0) {
      const pathD = s.points
        .map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${scaleX(x).toFixed(1)} ${scaleY(y).toFixed(1)}`)
        .join(' ');
      linesSvg += `<path d="${pathD}" fill="none" stroke="${color}" stroke-width="2" />\n`;

      for (const [x, y] of s.points) {
        linesSvg += `<circle cx="${scaleX(x).toFixed(1)}" cy="${scaleY(y).toFixed(1)}" r="3.5" fill="${color}" />\n`;
      }
    }

    legendSvg += `
      <rect x="${margin.left + idx * 120}" y="15" width="12" height="12" fill="${color}" />
      <text x="${margin.left + idx * 120 + 18}" y="25" fill="#333" font-size="12">${s.label}</text>
    `;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="background:#fff;font-family:sans-serif;">
    <text x="${width / 2}" y="25" text-anchor="middle" font-weight="bold" font-size="14">${options.title}</text>
    ${legendSvg}
    <!-- Grid and axes -->
    <line x1="${margin.left}" y1="${margin.top + plotH}" x2="${margin.left + plotW}" y2="${margin.top + plotH}" stroke="#888" stroke-width="1"/>
    <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="#888" stroke-width="1"/>
    <text x="${margin.left + plotW / 2}" y="${height - 10}" text-anchor="middle" font-size="12">${options.xLabel}</text>
    <text x="20" y="${margin.top + plotH / 2}" text-anchor="middle" font-size="12" transform="rotate(-90, 20, ${margin.top + plotH / 2})">${options.yLabel}</text>
    ${linesSvg}
  </svg>`;
}
