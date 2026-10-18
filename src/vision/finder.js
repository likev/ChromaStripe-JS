/**
 * Finder pattern detector: 1D scanline chrominance difference (R - G),
 * 1:1:3:1:1 ratio matcher, 2D vertical cross-check, sub-pixel centroid,
 * ROI tracking mode, and geometric corner ordering.
 */

/**
 * Searches for finder bullseyes in camera RGBA buffer.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba - Camera frame bytes
 * @param {number} width - Camera width
 * @param {number} height - Camera height
 * @param {object} [options]
 * @param {Array<{x: number, y: number}>} [options.prevCorners] - Optional tracking priors [TL, TR, BL, BR]
 * @param {number} [options.scanStep=4] - Scanline step
 * @returns {{
 *   found: boolean,
 *   corners?: { TL: {x,y}, TR: {x,y}, BL: {x,y}, BR: {x,y} },
 *   orderedCorners?: Array<{x: number, y: number}>,
 *   candidates?: any[]
 * }}
 */
export function findCorners(rgba, width, height, options = {}) {
  const prevCorners = options.prevCorners;

  // 1. ROI Fast Tracking Mode: if previous corners are valid, search local ROIs first
  if (prevCorners && prevCorners.length === 4) {
    const tracked = trackCornersROI(rgba, width, height, prevCorners);
    if (tracked.found) {
      return tracked;
    }
  }

  // 2. Full scanline search
  const scanStep = options.scanStep || 4;
  const candidates = [];
  const T = 35; // Chrominance threshold for Magenta (+T) vs Cyan (-T)

  const getPixelSign = (x, y) => {
    const idx = (y * width + x) * 4;
    const r = rgba[idx];
    const g = rgba[idx + 1];
    const b = rgba[idx + 2];
    const cd = r - g;
    // Magenta: cd >= T, Blue high and above green
    if (cd >= T && b >= 30 && b > g + 10) return 1;
    // Cyan: cd <= -T, Blue high and above red
    if (cd <= -T && b >= 30 && b > r + 10) return -1;
    return 0;
  };

  const minRow = 2;
  const maxRow = height - 2;

  for (let y = minRow; y < maxRow; y += scanStep) {
    // Run-length encode signs along row y
    const runs = [];
    let curSign = 0, runLen = 0, runStart = 0;

    for (let x = 0; x < width; x++) {
      const s = getPixelSign(x, y);
      if (s === curSign) {
        runLen++;
      } else {
        if (runLen > 0) runs.push({ sign: curSign, start: runStart, len: runLen });
        curSign = s;
        runStart = x;
        runLen = 1;
      }
    }
    if (runLen > 0) runs.push({ sign: curSign, start: runStart, len: runLen });

    // Look for 1:3:1 sequence:
    // Standard: +1 (ring) -> [transition <= 2px] -> -1 (core) -> [transition <= 2px] -> +1 (ring)
    // Inverted: -1 (ring) -> [transition <= 2px] -> +1 (core) -> [transition <= 2px] -> -1 (ring)
    for (let i = 0; i < runs.length; i++) {
      const r1 = runs[i];
      if (r1.sign === 0) continue;
      const targetCoreSign = -r1.sign;

      let j = i + 1;
      if (j < runs.length && runs[j].sign === 0 && runs[j].len <= 2) j++;
      if (j >= runs.length || runs[j].sign !== targetCoreSign) continue;
      const r2 = runs[j]; // core

      let k = j + 1;
      if (k < runs.length && runs[k].sign === 0 && runs[k].len <= 2) k++;
      if (k >= runs.length || runs[k].sign !== r1.sign) continue;
      const r3 = runs[k]; // ring

      // Check outer dark/neutral border (at least 2px)
      if (i === 0 || runs[i - 1].sign !== 0 || runs[i - 1].len < 2) continue;
      if (k + 1 >= runs.length || runs[k + 1].sign !== 0 || runs[k + 1].len < 2) continue;

      // Check ring thicknesses and 1:3:1 ratio
      const minRing = Math.min(r1.len, r3.len);
      const maxRing = Math.max(r1.len, r3.len);
      if (minRing < 2 || maxRing > minRing * 3.5) continue;

      const avgRing = (r1.len + r3.len) * 0.5;
      const coreRatio = r2.len / avgRing;
      if (coreRatio < 1.3 || coreRatio > 5.0) continue;

      const approxCenterX = Math.round(r2.start + r2.len * 0.5);
      const isInverted = (r2.sign === 1); // positive core -> inverted (BR)

      // Vertical cross-check
      const vCheck = crossCheckVertical(
        rgba,
        width,
        height,
        approxCenterX,
        y,
        r2.len,
        isInverted
      );

      if (vCheck.valid) {
        candidates.push({
          x: vCheck.refinedX,
          y: vCheck.refinedY,
          inverted: isInverted,
          size: r2.len
        });
      }
    }
  }

  // 3. Cluster candidates
  const clusters = clusterCandidates(candidates);
  if (clusters.length < 4) {
    return { found: false, candidates };
  }

  // Separate standard corners (TL, TR, BL) from inverted corner (BR)
  const standardClusters = clusters.filter(c => !c.inverted);
  const invertedClusters = clusters.filter(c => c.inverted);

  if (standardClusters.length < 3 || invertedClusters.length < 1) {
    return { found: false, candidates };
  }

  standardClusters.sort((a, b) => b.count - a.count);
  invertedClusters.sort((a, b) => b.count - a.count);

  const topStandards = standardClusters.slice(0, 6);
  const topInverteds = invertedClusters.slice(0, 3);

  let bestOrdered = null;
  let bestScore = -Infinity;

  for (const br of topInverteds) {
    for (let i = 0; i < topStandards.length; i++) {
      for (let j = i + 1; j < topStandards.length; j++) {
        for (let k = j + 1; k < topStandards.length; k++) {
          const three = [topStandards[i], topStandards[j], topStandards[k]];
          const ordered = orderCornersGeometry(three, br);
          if (!ordered) continue;

          const [tl, tr, bl] = [ordered[0], ordered[1], ordered[2]];
          const dTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
          const dBot = Math.hypot(br.x - bl.x, br.y - bl.y);
          const dLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
          const dRight = Math.hypot(br.x - tr.x, br.y - tr.y);

          const minSide = Math.min(dTop, dBot, dLeft, dRight);
          const maxSide = Math.max(dTop, dBot, dLeft, dRight);
          if (minSide < 30 || minSide / maxSide < 0.35) continue;

          // Convexity check: consecutive edge cross products must have same sign
          const cross = (ax, ay, bx, by) => ax * by - ay * bx;
          const c0 = cross(tr.x - tl.x, tr.y - tl.y, br.x - tr.x, br.y - tr.y);
          const c1 = cross(br.x - tr.x, br.y - tr.y, bl.x - br.x, bl.y - br.y);
          const c2 = cross(bl.x - br.x, bl.y - br.y, tl.x - bl.x, tl.y - bl.y);
          const c3 = cross(tl.x - bl.x, tl.y - bl.y, tr.x - tl.x, tr.y - tl.y);

          if ((c0 > 0 && (c1 <= 0 || c2 <= 0 || c3 <= 0)) ||
              (c0 < 0 && (c1 >= 0 || c2 >= 0 || c3 >= 0))) {
            continue;
          }

          // Shoelace area
          const area = 0.5 * Math.abs(
            (tl.x * tr.y - tr.x * tl.y) +
            (tr.x * br.y - br.x * tr.y) +
            (br.x * bl.y - bl.x * br.y) +
            (bl.x * tl.y - tl.x * bl.y)
          );
          if (area < 1500) continue;

          const score = (tl.count + tr.count + bl.count + br.count) * 1000 + area;
          if (score > bestScore) {
            bestScore = score;
            bestOrdered = ordered;
          }
        }
      }
    }
  }

  if (!bestOrdered) {
    return { found: false, candidates };
  }

  return {
    found: true,
    corners: {
      TL: bestOrdered[0],
      TR: bestOrdered[1],
      BL: bestOrdered[2],
      BR: bestOrdered[3]
    },
    orderedCorners: bestOrdered,
    candidates
  };
}

/**
 * Fast ROI tracking for subsequent frames once corner positions are locked.
 */
function trackCornersROI(rgba, width, height, prevCorners) {
  const refined = [];

  for (let i = 0; i < 4; i++) {
    const prior = prevCorners[i];
    const isInverted = (i === 3); // BR is inverted

    const isCore = (x, y) => {
      const ix = Math.max(0, Math.min(width - 1, Math.round(x)));
      const iy = Math.max(0, Math.min(height - 1, Math.round(y)));
      const idx = (iy * width + ix) * 4;
      const r = rgba[idx], g = rgba[idx + 1], b = rgba[idx + 2];
      const cd = r - g;
      if (b < 30) return false;
      return isInverted ? (cd >= 25 && b > g + 10) : (cd <= -25 && b > r + 10);
    };

    const cx = Math.round(prior.x);
    const cy = Math.round(prior.y);

    let startX = cx, startY = cy, found = false;
    if (isCore(cx, cy)) {
      found = true;
    } else {
      for (let d = 1; d <= 12 && !found; d += 2) {
        for (let dy = -d; dy <= d && !found; dy += 2) {
          for (let dx = -d; dx <= d && !found; dx += 2) {
            const sx = cx + dx;
            const sy = cy + dy;
            if (sx >= 4 && sx < width - 4 && sy >= 4 && sy < height - 4) {
              if (isCore(sx, sy)) {
                startX = sx;
                startY = sy;
                found = true;
              }
            }
          }
        }
      }
    }
    if (!found) return { found: false };

    let top = startY;
    while (top > Math.max(2, startY - 30) && isCore(startX, top)) top--;
    let bot = startY;
    while (bot < Math.min(height - 3, startY + 30) && isCore(startX, bot)) bot++;
    const coreH = bot - top - 1;
    if (coreH < 4 || coreH > 150) return { found: false };

    const refY = (top + bot + 1) * 0.5;
    const intY = Math.round(refY);

    let left = startX;
    while (left > Math.max(2, startX - 30) && isCore(left, intY)) left--;
    let right = startX;
    while (right < Math.min(width - 3, startX + 30) && isCore(right, intY)) right++;
    const coreW = right - left - 1;
    if (coreW < 4 || coreW > 150) return { found: false };

    const hwRatio = coreH / coreW;
    if (hwRatio < 0.4 || hwRatio > 2.5) return { found: false };

    const refX = (left + right + 1) * 0.5;

    // Use vertical cross-check to verify ring structure
    const vCheck = crossCheckVertical(
      rgba,
      width,
      height,
      Math.round(refX),
      Math.round(refY),
      coreW,
      isInverted
    );

    if (!vCheck.valid) {
      return { found: false };
    }
    refined.push({ x: vCheck.refinedX, y: vCheck.refinedY });
  }

  return {
    found: true,
    corners: {
      TL: refined[0],
      TR: refined[1],
      BL: refined[2],
      BR: refined[3]
    },
    orderedCorners: refined
  };
}

/**
 * 2D vertical cross-check: verifies 1:3:1 pattern and solid core vertically with transition skipping.
 */
function crossCheckVertical(rgba, width, height, cx, cy, expectedCoreW, inverted) {
  const isCore = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    const idx = (y * width + x) * 4;
    const r = rgba[idx], g = rgba[idx + 1], b = rgba[idx + 2];
    const cd = r - g;
    if (b < 30) return false;
    return inverted ? (cd >= 25 && b > g + 10) : (cd <= -25 && b > r + 10);
  };

  const isRing = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    const idx = (y * width + x) * 4;
    const r = rgba[idx], g = rgba[idx + 1], b = rgba[idx + 2];
    const cd = r - g;
    if (b < 30) return false;
    return inverted ? (cd <= -25 && b > r + 10) : (cd >= 25 && b > g + 10);
  };

  // 1. Measure core vertically
  let topCore = cy;
  while (topCore > 2 && isCore(cx, topCore)) topCore--;
  let botCore = cy;
  while (botCore < height - 3 && isCore(cx, botCore)) botCore++;

  const coreH = botCore - topCore - 1;
  if (coreH < 4) return { valid: false };

  // Aspect ratio check: core width and height must match within +/- 55%
  const hwRatio = coreH / expectedCoreW;
  if (hwRatio < 0.45 || hwRatio > 2.3) return { valid: false };

  // 2. Measure top ring (allowing up to 4 transition pixels)
  let topRingStart = topCore;
  while (topRingStart > 2 && !isRing(cx, topRingStart) && (topCore - topRingStart) <= 4) {
    topRingStart--;
  }
  let topRingEnd = topRingStart;
  while (topRingEnd > 2 && isRing(cx, topRingEnd)) {
    topRingEnd--;
  }
  const topRingH = topRingStart - topRingEnd;

  // 3. Measure bottom ring (allowing up to 4 transition pixels)
  let botRingStart = botCore;
  while (botRingStart < height - 3 && !isRing(cx, botRingStart) && (botRingStart - botCore) <= 4) {
    botRingStart++;
  }
  let botRingEnd = botRingStart;
  while (botRingEnd < height - 3 && isRing(cx, botRingEnd)) {
    botRingEnd++;
  }
  const botRingH = botRingEnd - botRingStart;

  if (topRingH < 2 || botRingH < 2) return { valid: false };
  if (coreH / topRingH < 1.1 || coreH / topRingH > 6.0) return { valid: false };
  if (coreH / botRingH < 1.1 || coreH / botRingH > 6.0) return { valid: false };

  // Check outer dark/neutral border (at least 1px)
  let topDarkH = 0;
  let pY = topRingEnd;
  while (pY >= 0 && !isRing(cx, pY) && !isCore(cx, pY) && topDarkH < 1) {
    topDarkH++;
    pY--;
  }
  if (topDarkH < 1) return { valid: false };

  let botDarkH = 0;
  pY = botRingEnd;
  while (pY < height && !isRing(cx, pY) && !isCore(cx, pY) && botDarkH < 1) {
    botDarkH++;
    pY++;
  }
  if (botDarkH < 1) return { valid: false };

  // 4. Centroid refinement in continuous image coordinates
  const refinedY = (topCore + botCore + 1) * 0.5;
  const intY = Math.round(refinedY);

  let leftCore = cx;
  while (leftCore > 2 && isCore(leftCore, intY)) leftCore--;
  let rightCore = cx;
  while (rightCore < width - 3 && isCore(rightCore, intY)) rightCore++;

  const refinedX = (leftCore + rightCore + 1) * 0.5;

  return {
    valid: true,
    refinedX,
    refinedY
  };
}

/**
 * Clusters nearby candidate detections within merge distance.
 */
function clusterCandidates(candidates) {
  const clusters = [];

  for (const cand of candidates) {
    let matched = false;
    const mergeDist = Math.max(12, cand.size * 1.5);
    const mergeDist2 = mergeDist * mergeDist;

    for (const cl of clusters) {
      if (cl.inverted !== cand.inverted) continue;
      const dx = cl.x - cand.x;
      const dy = cl.y - cand.y;
      if (dx * dx + dy * dy < mergeDist2) {
        cl.x = (cl.x * cl.count + cand.x) / (cl.count + 1);
        cl.y = (cl.y * cl.count + cand.y) / (cl.count + 1);
        cl.size = (cl.size * cl.count + cand.size) / (cl.count + 1);
        cl.count++;
        matched = true;
        break;
      }
    }
    if (!matched) {
      clusters.push({
        x: cand.x,
        y: cand.y,
        size: cand.size,
        count: 1,
        inverted: cand.inverted
      });
    }
  }

  return clusters;
}


/**
 * Orders 4 corners into [TL, TR, BL, BR] using BR as reference.
 */
function orderCornersGeometry(threeStandards, br) {
  if (threeStandards.length < 3 || !br) return null;

  // TL is the furthest corner from BR
  let maxDist2 = -1;
  let tlIdx = -1;

  for (let i = 0; i < 3; i++) {
    const dx = threeStandards[i].x - br.x;
    const dy = threeStandards[i].y - br.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > maxDist2) {
      maxDist2 = d2;
      tlIdx = i;
    }
  }

  const tl = threeStandards[tlIdx];
  const others = [];
  for (let i = 0; i < 3; i++) {
    if (i !== tlIdx) others.push(threeStandards[i]);
  }

  // Cross product from (TL -> BR) to (TL -> candidate)
  const vBRx = br.x - tl.x;
  const vBRy = br.y - tl.y;

  const cross = (pt) => {
    const vx = pt.x - tl.x;
    const vy = pt.y - tl.y;
    return vBRx * vy - vBRy * vx;
  };

  const cross0 = cross(others[0]);
  const cross1 = cross(others[1]);

  let tr, bl;
  if (cross0 < cross1) {
    tr = others[0];
    bl = others[1];
  } else {
    tr = others[1];
    bl = others[0];
  }

  return [tl, tr, bl, br];
}
