---
name: slides-create
description: Create and edit PowerPoint slide decks (.pptx) with PptxGenJS. Use when tasks involve building presentations, pitch decks, study result presentations, content strategy decks, or any slide-based deliverable. Triggers on "create slides", "build deck", "PowerPoint", "presentation", "pitch deck".
---

# Slide Deck Creation

## When to use

- Build new PowerPoint decks from scratch
- Recreate slides from screenshots/PDFs/reference decks
- Add charts, diagrams, visuals to presentations
- Any deliverable that needs to be a slide deck

## Dependencies

```bash
# Node.js required for PptxGenJS
npm install pptxgenjs

# For rendering/review
pip install pdf2image
brew install libreoffice poppler  # macOS
```

## Bundled Resources

- `~/openclaw/skills/slides-create/assets/pptxgenjs_helpers/` — Layout helpers, import into your deck workspace
- `~/openclaw/skills/slides-create/references/pptxgenjs-helpers.md` — API details
- `~/openclaw/skills/slides-create/scripts/render_slides.py` — Rasterize .pptx to per-slide PNGs
- `~/openclaw/skills/slides-create/scripts/slides_test.py` — Detect content overflow
- `~/openclaw/skills/slides-create/scripts/create_montage.py` — Contact-sheet montage of slides
- `~/openclaw/skills/slides-create/scripts/detect_font.py` — Report missing/substituted fonts
- `~/openclaw/skills/slides-create/scripts/ensure_raster_image.py` — Convert SVG/EMF/HEIC to PNG

## Workflow

### 1) Setup

- Set slide size upfront. Default to 16:9 (`LAYOUT_WIDE`) unless source material uses another ratio
- Copy `assets/pptxgenjs_helpers/` into working directory and import

### 2) Build the deck

- JavaScript with PptxGenJS
- Explicit theme font, stable spacing, editable PowerPoint-native elements
- Deliver both `.pptx` and source `.js`

### 3) Render and review

```bash
python3 ~/openclaw/skills/slides-create/scripts/render_slides.py deck.pptx --output_dir /tmp/slides_render
```

### 4) Validate

```bash
# Check for content overflow
python3 ~/openclaw/skills/slides-create/scripts/slides_test.py deck.pptx

# Check fonts
python3 ~/openclaw/skills/slides-create/scripts/detect_font.py deck.pptx
```

### 5) Quality standards

- Fix layout issues before delivery (overflow, alignment, font substitution)
- Re-render after every fix
- Professional styling, consistent theme throughout
