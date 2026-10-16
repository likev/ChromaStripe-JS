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

  const getCdiff = (x, y) => {
    const idx = (y * width + x) * 4;
    return rgba[idx] - rgba[idx + 1];
  };

  const minRow = 5;
  const maxRow = height - 5;

  for (let y = minRow; y < maxRow; y += scanStep) {
    // Run-length encode signs along row y
    // +1: cdiff >= T (Magenta)
    // -1: cdiff <= -T (Cyan)
    //  0: neutral / transition
    const runs = [];
    let curSign = 0, runLen = 0, runStart = 0;

    for (let x = 4; x < width - 4; x++) {
      const cd = getCdiff(x, y);
      const s = cd >= T ? 1 : (cd <= -T ? -1 : 0);
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
    // Standard: +1 (ring) -> [transition <= 4px] -> -1 (core) -> [transition <= 4px] -> +1 (ring)
    // Inverted: -1 (ring) -> [transition <= 4px] -> +1 (core) -> [transition <= 4px] -> -1 (ring)
    for (let i = 0; i < runs.length; i++) {
      const r1 = runs[i];
      if (r1.sign === 0) continue;
      const targetCoreSign = -r1.sign;

      let j = i + 1;
      if (j < runs.length && runs[j].sign === 0 && runs[j].len <= 5) j++;
      if (j >= runs.length || runs[j].sign !== targetCoreSign) continue;
      const r2 = runs[j]; // core

      let k = j + 1;
      if (k < runs.length && runs[k].sign === 0 && runs[k].len <= 5) k++;
      if (k >= runs.length || runs[k].sign !== r1.sign) continue;
      const r3 = runs[k]; // ring

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

  // 3. Cluster candidates within 30px
  const clusters = clusterCandidates(candidates);
  if (clusters.length < 4) {
    return { found: false, candidates };
  }

  // Find the top 4 clusters by hit count
  clusters.sort((a, b) => b.count - a.count);
  const top4 = clusters.slice(0, 4);

  // Inverted finder BR has positive inverted ratio
  top4.sort((a, b) => (b.invCount / b.count) - (a.invCount / a.count));
  const brCandidate = top4[0];
  const standardCandidates = top4.slice(1);

  // 4. Geometrically order corners [TL, TR, BL, BR]
  const ordered = orderCornersGeometry(standardCandidates, brCandidate);
  if (!ordered) {
    return { found: false, candidates };
  }

  return {
    found: true,
    corners: {
      TL: ordered[0],
      TR: ordered[1],
      BL: ordered[2],
      BR: ordered[3]
    },
    orderedCorners: ordered,
    candidates
  };
}

/**
 * Fast ROI tracking for subsequent frames once corner positions are locked.
 */
function trackCornersROI(rgba, width, height, prevCorners) {
  const getCdiff = (x, y) => {
    const ix = Math.max(0, Math.min(width - 1, Math.round(x)));
    const iy = Math.max(0, Math.min(height - 1, Math.round(y)));
    const idx = (iy * width + ix) * 4;
    return rgba[idx] - rgba[idx + 1];
  };

  const refined = [];
  const cornerNames = ['TL', 'TR', 'BL', 'BR'];

  for (let i = 0; i < 4; i++) {
    const prior = prevCorners[i];
    const isInverted = (i === 3); // BR is inverted
    const isCore = (cd) => isInverted ? cd >= 25 : cd <= -25;

    // Search in +/- 20 px around prior
    const cx = Math.round(prior.x);
    const cy = Math.round(prior.y);

    let top = cy;
    while (top > Math.max(2, cy - 25) && isCore(getCdiff(cx, top))) top--;
    let bot = cy;
    while (bot < Math.min(height - 3, cy + 25) && isCore(getCdiff(cx, bot))) bot++;
    const coreH = bot - top - 1;
    if (coreH < 4) return { found: false };

    const refY = (top + bot + 1) * 0.5;
    const intY = Math.round(refY);

    let left = cx;
    while (left > Math.max(2, cx - 25) && isCore(getCdiff(left, intY))) left--;
    let right = cx;
    while (right < Math.min(width - 3, cx + 25) && isCore(getCdiff(right, intY))) right++;
    const coreW = right - left - 1;
    if (coreW < 4) return { found: false };

    const refX = (left + right + 1) * 0.5;
    refined.push({ x: refX, y: refY });
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
  const getCdiff = (x, y) => {
    const idx = (y * width + x) * 4;
    return rgba[idx] - rgba[idx + 1];
  };

  const isCore = (cd) => inverted ? cd >= 25 : cd <= -25;
  const isRing = (cd) => inverted ? cd <= -25 : cd >= 25;

  // 1. Measure core vertically
  let topCore = cy;
  while (topCore > 2 && isCore(getCdiff(cx, topCore))) topCore--;
  let botCore = cy;
  while (botCore < height - 3 && isCore(getCdiff(cx, botCore))) botCore++;

  const coreH = botCore - topCore - 1;
  if (coreH < 4) return { valid: false };

  // Aspect ratio check: core width and height must match within +/- 55%
  const hwRatio = coreH / expectedCoreW;
  if (hwRatio < 0.45 || hwRatio > 2.3) return { valid: false };

  // 2. Measure top ring (allowing up to 4 transition pixels)
  let topRingStart = topCore;
  while (topRingStart > 2 && Math.abs(getCdiff(cx, topRingStart)) < 25 && (topCore - topRingStart) <= 4) {
    topRingStart--;
  }
  let topRingEnd = topRingStart;
  while (topRingEnd > 2 && isRing(getCdiff(cx, topRingEnd))) {
    topRingEnd--;
  }
  const topRingH = topRingStart - topRingEnd;

  // 3. Measure bottom ring (allowing up to 4 transition pixels)
  let botRingStart = botCore;
  while (botRingStart < height - 3 && Math.abs(getCdiff(cx, botRingStart)) < 25 && (botRingStart - botCore) <= 4) {
    botRingStart++;
  }
  let botRingEnd = botRingStart;
  while (botRingEnd < height - 3 && isRing(getCdiff(cx, botRingEnd))) {
    botRingEnd++;
  }
  const botRingH = botRingEnd - botRingStart;

  if (topRingH < 2 || botRingH < 2) return { valid: false };
  if (coreH / topRingH < 1.1 || coreH / topRingH > 6.0) return { valid: false };
  if (coreH / botRingH < 1.1 || coreH / botRingH > 6.0) return { valid: false };

  // 4. Centroid refinement in continuous image coordinates
  const refinedY = (topCore + botCore + 1) * 0.5;
  const intY = Math.round(refinedY);

  let leftCore = cx;
  while (leftCore > 2 && isCore(getCdiff(leftCore, intY))) leftCore--;
  let rightCore = cx;
  while (rightCore < width - 3 && isCore(getCdiff(rightCore, intY))) rightCore++;

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
  const MERGE_DIST2 = 30 * 30;

  for (const cand of candidates) {
    let matched = false;
    for (const cl of clusters) {
      const dx = cl.x - cand.x;
      const dy = cl.y - cand.y;
      if (dx * dx + dy * dy < MERGE_DIST2) {
        cl.x = (cl.x * cl.count + cand.x) / (cl.count + 1);
        cl.y = (cl.y * cl.count + cand.y) / (cl.count + 1);
        cl.count++;
        if (cand.inverted) cl.invCount++;
        matched = true;
        break;
      }
    }
    if (!matched) {
      clusters.push({
        x: cand.x,
        y: cand.y,
        count: 1,
        invCount: cand.inverted ? 1 : 0
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
