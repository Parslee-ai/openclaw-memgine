---
name: docx-create
description: Create, edit, and review Word documents (.docx) with professional formatting. Use when tasks involve generating reports, proposals, case studies, white papers, or any formatted document output. Triggers on "create document", "write report", "generate docx", "Word document", or any request for formatted document deliverables.
---

# DOCX Document Creation

## When to use

- Create new Word documents with professional formatting (headings, styles, tables, lists)
- Edit existing .docx files while preserving formatting
- Generate reports, proposals, case studies, white papers
- Any deliverable that needs to look polished as a document

## Dependencies

```bash
# Install if missing
pip install python-docx pdf2image

# For visual rendering (macOS)
brew install libreoffice poppler
```

## Workflow

### 1) Create/edit with python-docx

Use `python-docx` for all document creation and editing. Key patterns:

- Headings, paragraphs, styles, tables, lists
- Consistent typography, spacing, margins
- Professional hierarchy and structure

### 2) Visual review (render and inspect)

After each meaningful change, render to PNG and verify:

```bash
# DOCX → PDF
soffice --headless --convert-to pdf --outdir /tmp/doc_render input.docx

# PDF → PNGs
pdftoppm -png /tmp/doc_render/input.pdf /tmp/doc_render/page

# Or use the bundled helper:
python3 ~/openclaw/skills/docx-create/scripts/render_docx.py input.docx --output_dir /tmp/doc_pages
```

### 3) Quality standards

- Client-ready: consistent typography, spacing, margins, clear hierarchy
- No clipped/overlapping text, broken tables, or default-template styling
- Charts, tables, and visuals must be legible and aligned
- Use ASCII hyphens only (avoid Unicode dashes)
- Re-render and inspect every page before delivery

## Output conventions

- Save final documents to the requesting agent's workspace or a specified path
- Use descriptive filenames
- Clean up intermediate render files after delivery
