/**
 * Finder pattern detector: 1D scanline chrominance difference (R - G),
 * 1:1:3:1:1 ratio matcher, full 2D vertical cross-check, sub-pixel centroid,
 * and geometric corner ordering.
 */

/**
 * Searches for finder bullseyes in camera RGBA buffer.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba - Camera frame bytes
 * @param {number} width - Camera width
 * @param {number} height - Camera height
 * @param {object} [options]
 * @param {Array<{x: number, y: number}>} [options.prevCorners] - Optional tracking priors
 * @param {number} [options.scanStep=4] - Scanline step
 * @returns {{
 *   found: boolean,
 *   corners?: { TL: {x,y}, TR: {x,y}, BL: {x,y}, BR: {x,y} },
 *   orderedCorners?: Array<{x: number, y: number}>,
 *   candidates?: any[]
 * }}
 */
export function findCorners(rgba, width, height, options = {}) {
  const scanStep = options.scanStep || 4;
  const candidates = [];

  const getPixel = (x, y) => {
    const idx = (y * width + x) * 4;
    return {
      r: rgba[idx],
      g: rgba[idx + 1],
      b: rgba[idx + 2],
      cdiff: rgba[idx] - rgba[idx + 1],
      luma: 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2]
    };
  };

  // 1. Scan rows every scanStep
  const minRow = 5;
  const maxRow = height - 5;

  for (let y = minRow; y < maxRow; y += scanStep) {
    let state = 0; // 0: outer, 1: ring, 2: core, 3: ring
    let startX = 0;
    let seg1Len = 0, seg2Len = 0, seg3Len = 0;
    let isCandidateInverted = false;

    for (let x = 5; x < width - 5; x++) {
      const p = getPixel(x, y);

      if (state === 0) {
        if (p.cdiff >= 45) {
          // Standard candidate: enters Magenta ring
          state = 1;
          startX = x;
          isCandidateInverted = false;
        } else if (p.cdiff <= -45) {
          // Inverted candidate: enters Cyan ring
          state = 1;
          startX = x;
          isCandidateInverted = true;
        }
      } else if (state === 1) {
        const inCore = isCandidateInverted ? (p.cdiff >= 40) : (p.cdiff <= -40);
        if (inCore) {
          seg1Len = x - startX;
          state = 2;
          startX = x;
        } else {
          const stillRing = isCandidateInverted ? (p.cdiff <= -25) : (p.cdiff >= 25);
          if (!stillRing || (x - startX > 150)) {
            state = 0; // reset
          }
        }
      } else if (state === 2) {
        const exitCore = isCandidateInverted ? (p.cdiff <= -35) : (p.cdiff >= 35);
        if (exitCore) {
          seg2Len = x - startX;
          state = 3;
          startX = x;
        } else {
          const stillCore = isCandidateInverted ? (p.cdiff >= 25) : (p.cdiff <= -25);
          if (!stillCore || (x - startX > 300)) {
            state = 0; // reset
          }
        }
      } else if (state === 3) {
        const exitRing = isCandidateInverted ? (p.cdiff > -20) : (p.cdiff < 20);
        if (exitRing) {
          seg3Len = x - startX;
          state = 0;

          // Check 1:3:1 ratio
          const minRing = Math.min(seg1Len, seg3Len);
          const maxRing = Math.max(seg1Len, seg3Len);

          if (minRing >= 2 && maxRing <= minRing * 2.5) {
            const expectedCore = (seg1Len + seg3Len) * 1.5;
            if (seg2Len >= expectedCore * 0.45 && seg2Len <= expectedCore * 2.2) {
              const approxCenterX = Math.round(startX - seg3Len - seg2Len / 2);

              // 2. Full vertical cross check
              const vCheck = crossCheckVertical(
                rgba,
                width,
                height,
                approxCenterX,
                y,
                seg2Len,
                isCandidateInverted
              );

              if (vCheck.valid) {
                candidates.push({
                  x: vCheck.refinedX,
                  y: vCheck.refinedY,
                  inverted: isCandidateInverted,
                  size: seg2Len
                });
              }
            }
          }
        }
      }
    }
  }

  // 3. Cluster candidate detections
  const clusters = clusterCandidates(candidates);
  if (clusters.length < 4) {
    return { found: false, candidates };
  }

  // Find the inverted BR corner and 3 standard corners
  let brCandidate = null;
  let standardCandidates = [];

  // Sort clusters by count (number of scanline hits)
  clusters.sort((a, b) => b.count - a.count);

  for (const c of clusters) {
    if (c.inverted && !brCandidate) {
      brCandidate = c;
    } else {
      standardCandidates.push(c);
    }
  }

  if (!brCandidate || standardCandidates.length < 3) {
    // If polarity is slightly noisy, pick top 4 clusters and select BR by maximum invertedScore
    if (clusters.length < 4) return { found: false, candidates };
    const top4 = clusters.slice(0, 4);
    top4.sort((a, b) => b.invertedScore - a.invertedScore);
    brCandidate = top4[0];
    standardCandidates = top4.slice(1);
  }

  if (standardCandidates.length < 3) {
    return { found: false, candidates };
  }

  // 4. Geometrically order corners [TL, TR, BL, BR]
  const ordered = orderCornersGeometry(standardCandidates.slice(0, 3), brCandidate);
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
 * 2D vertical cross check: confirms 1:3:1 pattern and solid core vertically.
 */
function crossCheckVertical(rgba, width, height, cx, cy, expectedCoreW, inverted) {
  const getCdiff = (x, y) => {
    const idx = (y * width + x) * 4;
    return rgba[idx] - rgba[idx + 1];
  };

  const minY = Math.max(2, cy - 100);
  const maxY = Math.min(height - 2, cy + 100);

  // 1. Measure core vertically
  let topCore = cy;
  while (topCore > minY) {
    const cd = getCdiff(cx, topCore);
    const inCore = inverted ? (cd >= 25) : (cd <= -25);
    if (!inCore) break;
    topCore--;
  }

  let botCore = cy;
  while (botCore < maxY) {
    const cd = getCdiff(cx, botCore);
    const inCore = inverted ? (cd >= 25) : (cd <= -25);
    if (!inCore) break;
    botCore++;
  }

  const coreH = botCore - (topCore + 1);
  if (coreH < 4) return { valid: false };

  // Aspect ratio check: core width and height must match within +/- 40%
  const ratio = coreH / expectedCoreW;
  if (ratio < 0.5 || ratio > 2.0) return { valid: false };

  // 2. Measure top ring
  let topRing = topCore;
  while (topRing > minY) {
    const cd = getCdiff(cx, topRing);
    const inRing = inverted ? (cd <= -20) : (cd >= 20);
    if (!inRing) break;
    topRing--;
  }
  const topRingH = (topCore + 1) - (topRing + 1);

  // 3. Measure bottom ring
  let botRing = botCore;
  while (botRing < maxY) {
    const cd = getCdiff(cx, botRing);
    const inRing = inverted ? (cd <= -20) : (cd >= 20);
    if (!inRing) break;
    botRing++;
  }
  const botRingH = botRing - botCore;

  // Ring height must be roughly coreH / 3
  const expectedRingH = coreH / 3.0;
  if (topRingH < expectedRingH * 0.3 || topRingH > expectedRingH * 2.5) return { valid: false };
  if (botRingH < expectedRingH * 0.3 || botRingH > expectedRingH * 2.5) return { valid: false };

  // 4. Compute continuous sub-pixel centroid
  const refinedY = (topCore + botCore + 1) / 2.0;
  const intY = Math.round(refinedY);

  // Refine horizontal centroid at refinedY
  let leftCore = cx;
  while (leftCore > Math.max(2, cx - 100)) {
    const cd = getCdiff(leftCore, intY);
    const inCore = inverted ? (cd >= 25) : (cd <= -25);
    if (!inCore) break;
    leftCore--;
  }
  let rightCore = cx;
  while (rightCore < Math.min(width - 2, cx + 100)) {
    const cd = getCdiff(rightCore, intY);
    const inCore = inverted ? (cd >= 25) : (cd <= -25);
    if (!inCore) break;
    rightCore++;
  }

  const refinedX = (leftCore + rightCore + 1) / 2.0;

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
        if (cand.inverted) cl.invertedScore++;
        else cl.invertedScore--;
        matched = true;
        break;
      }
    }
    if (!matched) {
      clusters.push({
        x: cand.x,
        y: cand.y,
        count: 1,
        invertedScore: cand.inverted ? 1 : -1,
        inverted: cand.inverted
      });
    }
  }

  for (const cl of clusters) {
    cl.inverted = cl.invertedScore > 0;
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
