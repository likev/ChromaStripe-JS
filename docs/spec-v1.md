# ChromaStripe-JS v1 Specification (Frozen)

This document formalizes the frozen v1 wire format, physical modulation, framing, computer vision, and channel coding specifications for ChromaStripe-JS.

---

## 1. Physical Modulation
- **Logical Grid:** 80 × 80 macro-cells (6,400 total cells).
- **Cell Geometry at scale $s$:** $10s \times 10s$ device pixels:
  - Solid core: $8s \times 8s$ pixels.
  - Black guard band: $s$ pixels on each side ($2s$ pixels of black between adjacent cores).
- **Base Canvas:** $800 \times 800$ pixels at $s = 1$.
- **Quiet Zone:** $\ge 2$ cells of mid-gray (`#808080`) surrounding the code area.
- **Constellation:** 8-state RGB cube (3 bits per cell):
  $$(b_2, b_1, b_0) \mapsto (R, G, B)$$
  where:
  - $R = b_2 ? 255 : 40$
  - $G = b_1 ? 255 : 40$
  - $B = b_0 ? 255 : 40$

---

## 2. Cell Map & Layout
| Classification | Coordinates | Count |
|---|---|---|
| **Finder zones** | 4 corners ($8 \times 8$ cells each: TL, TR, BL, BR) | $4 \times 64 = 256$ |
| **Timing tracks** | Row 0, row 79, col 0, col 79 outside finders | $4 \times 64 = 256$ |
| **Calibration pilots** | 16 blocks of $2 \times 2$ cells at $\{9, 10\} + 20i$, $i = 0..3$ | $16 \times 4 = 64$ |
| **Data cells** | All remaining cells across 4 horizontal stripes | **5,824** |

### Stripe Partitions
| Stripe | Row Range | Height | Data Cells | Packet Bytes |
|---|---|---|---|---|
| Stripe 0 | Rows 0–20 | 21 | 1,446 | 542 B |
| Stripe 1 | Rows 21–39 | 19 | 1,466 | 542 B (+ 20 fill) |
| Stripe 2 | Rows 40–58 | 19 | 1,466 | 542 B (+ 20 fill) |
| Stripe 3 | Rows 59–79 | 21 | 1,446 | 542 B |

---

## 3. Packet Wire Format (542 Bytes)
Each stripe packet is exactly 542 bytes, organized as:
1. **Header (12 bytes):**
   - Offset 0 (1B): `ver[7:6] = 01`, `stripeIdx[5:4]`, `phase[3:2]`, `reserved[1:0]`
   - Offset 1 (3B): `seed` (uint24, big-endian)
   - Offset 4 (2B): `K` (uint16, big-endian)
   - Offset 6 (2B): `sessionId` (uint16, big-endian)
   - Offset 8 (4B): `CRC32` (IEEE 802.3 over bytes 0..7 + 448B payload)
2. **Payload (448 bytes):**
   - Offset 12 (448B): 112 uint32 words representing one fountain droplet.
3. **Inner ECC (82 bytes):**
   - Offset 460 (82B): 3 interleaved Reed-Solomon codewords over GF(256), poly `0x11D`:
     - Codeword 0: 154 data + 28 parity = 182 B ($t = 14$)
     - Codeword 1: 153 data + 27 parity = 180 B ($t = 13$)
     - Codeword 2: 153 data + 27 parity = 180 B ($t = 13$)
4. **Scrambler:**
   All 542 bytes are XORed with a deterministic `xorshift32` stream seeded by:
   `0xC5A00000 | (ver << 8) | stripeIdx`.

---

## 4. Source Stream & Manifest
- **Pre-compression:** Deflate-raw (`CompressionStream('deflate-raw')`). Used if size shrinks by $\ge 2\%$.
- **Manifest Header:**
  - Magic: `"CSv1"` (4 bytes)
  - `manifestLen` (uint16)
  - `flags` (uint8: bit 0 = compression)
  - `originalSize` (uint32)
  - `payloadSize` (uint32)
  - `sha256(original)` (32 bytes)
  - `nameLen` (uint8) + `name` (UTF-8)
  - `mimeLen` (uint8) + `mime` (UTF-8)
- Padded with zeros to $K \times 448$ bytes.
