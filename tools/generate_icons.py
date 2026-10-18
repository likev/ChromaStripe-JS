#!/usr/bin/env python3
"""
Generate ChromaStripe-JS PWA icons (PNG, ICO, SVG).
Zero external binary dependencies; uses Python Pillow.
"""

import os
from PIL import Image, ImageDraw, ImageFilter

OUTPUT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../web/public'))
ICONS_DIR = os.path.join(OUTPUT_DIR, 'icons')

os.makedirs(ICONS_DIR, exist_ok=True)

# ChromaStripe brand palette
BG_DARK = (11, 15, 25, 255)       # #0b0f19
CARD_DARK = (21, 28, 46, 255)     # #151c2e
BORDER_COLOR = (30, 41, 59, 255)  # #1e293b
COLOR_CYAN = (0, 240, 255, 255)
COLOR_BLUE = (59, 130, 246, 255)
COLOR_GREEN = (16, 185, 129, 255)
COLOR_YELLOW = (245, 158, 11, 255)
COLOR_RED = (239, 68, 68, 255)
COLOR_MAGENTA = (236, 72, 153, 255)
COLOR_WHITE = (255, 255, 255, 255)

def draw_corner_finder(draw, cx, cy, size, color):
    """Draw a 3-tier concentric finder pattern (outer box, white inner, center dot)."""
    half = size / 2
    # Outer box
    draw.rectangle([cx - half, cy - half, cx + half, cy + half], outline=color, width=max(1, int(size * 0.16)))
    # Inner center dot
    dot_half = size * 0.22
    draw.rectangle([cx - dot_half, cy - dot_half, cx + dot_half, cy + dot_half], fill=color)

def draw_icon_canvas(canvas_size, maskable=False, round_corners=True):
    """
    Renders high-resolution icon using supersampling (4x) for ultra-sharp edges.
    """
    scale = 4
    dim = canvas_size * scale
    img = Image.new('RGBA', (dim, dim), (0, 0, 0, 0) if not maskable and round_corners else BG_DARK)
    draw = ImageDraw.Draw(img)

    margin = dim * (0.12 if maskable else 0.04)
    content_w = dim - 2 * margin
    content_h = dim - 2 * margin

    # Background card / container
    if not maskable:
        radius = int(dim * 0.18) if round_corners else 0
        card_bbox = [margin, margin, dim - margin, dim - margin]
        if round_corners:
            draw.rounded_rectangle(card_bbox, radius=radius, fill=BG_DARK, outline=BORDER_COLOR, width=int(scale * 3))
        else:
            draw.rectangle(card_bbox, fill=BG_DARK)

    # 4 Chroma stripes with optical macro-cells
    stripe_colors = [
        [COLOR_CYAN, COLOR_BLUE, COLOR_CYAN, COLOR_BLUE, COLOR_CYAN],
        [COLOR_GREEN, COLOR_BLUE, COLOR_GREEN, COLOR_CYAN, COLOR_GREEN],
        [COLOR_YELLOW, COLOR_GREEN, COLOR_YELLOW, COLOR_CYAN, COLOR_YELLOW],
        [COLOR_RED, COLOR_MAGENTA, COLOR_RED, COLOR_MAGENTA, COLOR_RED]
    ]

    stripe_top = margin + content_h * 0.20
    stripe_bottom = margin + content_h * 0.80
    total_stripe_h = stripe_bottom - stripe_top
    stripe_h = total_stripe_h / 4
    cell_w = content_w * 0.10
    cell_pad = cell_w * 0.12

    # Draw macro-cell grid in background
    for s_idx in range(4):
        sy = stripe_top + s_idx * stripe_h
        for c_idx in range(9):
            cx = margin + content_w * 0.05 + c_idx * cell_w
            # Skip cells near center where bolt will be
            dist_to_center = abs(cx + cell_w/2 - dim/2)
            if dist_to_center < content_w * 0.18:
                continue
            color = stripe_colors[s_idx][c_idx % len(stripe_colors[s_idx])]
            # Slightly translucent background cells
            alpha_color = (color[0], color[1], color[2], 180)
            cell_box = [cx + cell_pad, sy + cell_pad, cx + cell_w - cell_pad, sy + stripe_h - cell_pad]
            draw.rounded_rectangle(cell_box, radius=int(scale * 2), fill=alpha_color)

    # Corner finders
    finder_size = content_w * 0.15
    f_offset = margin + content_w * 0.10
    draw_corner_finder(draw, f_offset, f_offset, finder_size, COLOR_CYAN)
    draw_corner_finder(draw, dim - f_offset, f_offset, finder_size, COLOR_MAGENTA)
    draw_corner_finder(draw, f_offset, dim - f_offset, finder_size, COLOR_YELLOW)
    draw_corner_finder(draw, dim - f_offset, dim - f_offset, finder_size, COLOR_GREEN)

    # Central glowing lightning bolt
    # Bolt coords relative to content center
    bolt_pts = [
        (dim * 0.53, dim * 0.25),
        (dim * 0.38, dim * 0.49),
        (dim * 0.50, dim * 0.49),
        (dim * 0.44, dim * 0.75),
        (dim * 0.62, dim * 0.47),
        (dim * 0.50, dim * 0.47)
    ]

    # Glow layer for bolt
    glow = Image.new('RGBA', (dim, dim), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.polygon(bolt_pts, fill=COLOR_CYAN)
    glow = glow.filter(ImageFilter.GaussianBlur(radius=int(scale * 12)))
    img = Image.alpha_composite(img, glow)

    # Crisp white bolt on top with subtle cyan border
    draw = ImageDraw.Draw(img)
    draw.polygon(bolt_pts, fill=COLOR_WHITE, outline=COLOR_CYAN, width=int(scale * 3))

    # Downscale using Lanczos filter
    img_resized = img.resize((canvas_size, canvas_size), Image.Resampling.LANCZOS)
    return img_resized


def generate_svg_icon():
    svg_content = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0b0f19" />
      <stop offset="100%" stop-color="#151c2e" />
    </linearGradient>
    <linearGradient id="boltGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" />
      <stop offset="100%" stop-color="#e0f2fe" />
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="8" result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>

  <!-- Background Card -->
  <rect width="512" height="512" rx="96" fill="url(#bgGrad)" stroke="#1e293b" stroke-width="8" />

  <!-- Corner Finders -->
  <!-- Top Left (Cyan) -->
  <g transform="translate(48, 48)">
    <rect width="64" height="64" rx="8" fill="none" stroke="#00f0ff" stroke-width="8"/>
    <rect x="20" y="20" width="24" height="24" rx="4" fill="#00f0ff"/>
  </g>
  <!-- Top Right (Magenta) -->
  <g transform="translate(400, 48)">
    <rect width="64" height="64" rx="8" fill="none" stroke="#ec4899" stroke-width="8"/>
    <rect x="20" y="20" width="24" height="24" rx="4" fill="#ec4899"/>
  </g>
  <!-- Bottom Left (Yellow) -->
  <g transform="translate(48, 400)">
    <rect width="64" height="64" rx="8" fill="none" stroke="#f59e0b" stroke-width="8"/>
    <rect x="20" y="20" width="24" height="24" rx="4" fill="#f59e0b"/>
  </g>
  <!-- Bottom Right (Green) -->
  <g transform="translate(400, 400)">
    <rect width="64" height="64" rx="8" fill="none" stroke="#10b981" stroke-width="8"/>
    <rect x="20" y="20" width="24" height="24" rx="4" fill="#10b981"/>
  </g>

  <!-- Optical Macro-Cell Stripes -->
  <!-- Stripe 1 (Cyan / Blue) -->
  <g opacity="0.75">
    <rect x="52" y="150" width="36" height="30" rx="4" fill="#00f0ff" />
    <rect x="96" y="150" width="36" height="30" rx="4" fill="#3b82f6" />
    <rect x="140" y="150" width="36" height="30" rx="4" fill="#00f0ff" />
    <rect x="336" y="150" width="36" height="30" rx="4" fill="#3b82f6" />
    <rect x="380" y="150" width="36" height="30" rx="4" fill="#00f0ff" />
    <rect x="424" y="150" width="36" height="30" rx="4" fill="#3b82f6" />
  </g>
  <!-- Stripe 2 (Green / Cyan) -->
  <g opacity="0.75">
    <rect x="52" y="210" width="36" height="30" rx="4" fill="#10b981" />
    <rect x="96" y="210" width="36" height="30" rx="4" fill="#06b6d4" />
    <rect x="140" y="210" width="36" height="30" rx="4" fill="#10b981" />
    <rect x="336" y="210" width="36" height="30" rx="4" fill="#10b981" />
    <rect x="380" y="210" width="36" height="30" rx="4" fill="#06b6d4" />
    <rect x="424" y="210" width="36" height="30" rx="4" fill="#10b981" />
  </g>
  <!-- Stripe 3 (Yellow / Amber) -->
  <g opacity="0.75">
    <rect x="52" y="270" width="36" height="30" rx="4" fill="#f59e0b" />
    <rect x="96" y="270" width="36" height="30" rx="4" fill="#eab308" />
    <rect x="140" y="270" width="36" height="30" rx="4" fill="#f59e0b" />
    <rect x="336" y="270" width="36" height="30" rx="4" fill="#f59e0b" />
    <rect x="380" y="270" width="36" height="30" rx="4" fill="#eab308" />
    <rect x="424" y="270" width="36" height="30" rx="4" fill="#f59e0b" />
  </g>
  <!-- Stripe 4 (Red / Magenta) -->
  <g opacity="0.75">
    <rect x="52" y="330" width="36" height="30" rx="4" fill="#ef4444" />
    <rect x="96" y="330" width="36" height="30" rx="4" fill="#ec4899" />
    <rect x="140" y="330" width="36" height="30" rx="4" fill="#ef4444" />
    <rect x="336" y="330" width="36" height="30" rx="4" fill="#ef4444" />
    <rect x="380" y="330" width="36" height="30" rx="4" fill="#ec4899" />
    <rect x="424" y="330" width="36" height="30" rx="4" fill="#ef4444" />
  </g>

  <!-- Central Lightning Bolt (Chroma Modem Pulse) -->
  <polygon points="275,128 194,256 256,256 225,384 317,240 256,240"
           fill="#00f0ff" opacity="0.4" filter="url(#glow)" />
  <polygon points="275,128 194,256 256,256 225,384 317,240 256,240"
           fill="url(#boltGrad)" stroke="#00f0ff" stroke-width="4" stroke-linejoin="round" />
</svg>
'''
    return svg_content


def generate_favicon_svg():
    # Compact, high-visibility SVG favicon
    svg_content = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="14" fill="#0b0f19" />
  <!-- Mini Finders -->
  <rect x="6" y="6" width="10" height="10" rx="2" fill="none" stroke="#00f0ff" stroke-width="2"/>
  <rect x="9" y="9" width="4" height="4" fill="#00f0ff"/>
  <rect x="48" y="6" width="10" height="10" rx="2" fill="none" stroke="#ec4899" stroke-width="2"/>
  <rect x="51" y="9" width="4" height="4" fill="#ec4899"/>
  <rect x="6" y="48" width="10" height="10" rx="2" fill="none" stroke="#f59e0b" stroke-width="2"/>
  <rect x="9" y="51" width="4" height="4" fill="#f59e0b"/>
  <rect x="48" y="48" width="10" height="10" rx="2" fill="none" stroke="#10b981" stroke-width="2"/>
  <rect x="51" y="51" width="4" height="4" fill="#10b981"/>
  <!-- Bolt -->
  <polygon points="35,16 24,32 32,32 28,48 40,30 32,30"
           fill="#ffffff" stroke="#00f0ff" stroke-width="1.5" stroke-linejoin="round"/>
</svg>
'''
    return svg_content


def main():
    print(f"Generating ChromaStripe PWA icons in {OUTPUT_DIR}...")

    # 1. Standard PNG icons
    icon_512 = draw_icon_canvas(512, maskable=False, round_corners=True)
    icon_512.save(os.path.join(ICONS_DIR, 'icon-512.png'), 'PNG')
    print("  ✓ icons/icon-512.png")

    icon_192 = draw_icon_canvas(192, maskable=False, round_corners=True)
    icon_192.save(os.path.join(ICONS_DIR, 'icon-192.png'), 'PNG')
    print("  ✓ icons/icon-192.png")

    # 2. Maskable PNG icons (safe zone circle margin, full-bleed dark bg)
    maskable_512 = draw_icon_canvas(512, maskable=True, round_corners=False)
    maskable_512.save(os.path.join(ICONS_DIR, 'icon-maskable-512.png'), 'PNG')
    print("  ✓ icons/icon-maskable-512.png")

    maskable_192 = draw_icon_canvas(192, maskable=True, round_corners=False)
    maskable_192.save(os.path.join(ICONS_DIR, 'icon-maskable-192.png'), 'PNG')
    print("  ✓ icons/icon-maskable-192.png")

    # 3. Apple Touch Icon (180x180, solid dark bg)
    apple_icon = draw_icon_canvas(180, maskable=False, round_corners=False)
    apple_icon.save(os.path.join(OUTPUT_DIR, 'apple-touch-icon.png'), 'PNG')
    print("  ✓ apple-touch-icon.png")

    # 4. Multi-size Favicon ICO (16x16, 32x32, 48x48)
    ico_16 = draw_icon_canvas(16, maskable=False, round_corners=False)
    ico_32 = draw_icon_canvas(32, maskable=False, round_corners=False)
    ico_48 = draw_icon_canvas(48, maskable=False, round_corners=False)
    ico_path = os.path.join(OUTPUT_DIR, 'favicon.ico')
    ico_48.save(ico_path, format='ICO', sizes=[(16, 16), (32, 32), (48, 48)], append_images=[ico_16, ico_32])
    print("  ✓ favicon.ico (16x16, 32x32, 48x48)")

    # 5. SVGs
    svg_icon = generate_svg_icon()
    with open(os.path.join(ICONS_DIR, 'icon.svg'), 'w', encoding='utf-8') as f:
        f.write(svg_icon)
    print("  ✓ icons/icon.svg")

    favicon_svg = generate_favicon_svg()
    with open(os.path.join(OUTPUT_DIR, 'favicon.svg'), 'w', encoding='utf-8') as f:
        f.write(favicon_svg)
    print("  ✓ favicon.svg")

    print("All icons successfully generated!")

if __name__ == '__main__':
    main()
