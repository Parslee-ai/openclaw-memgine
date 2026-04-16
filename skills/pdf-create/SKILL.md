---
name: pdf-create
description: Create and review PDF documents with professional formatting. Use when tasks involve generating polished PDFs — reports, analysis summaries, formatted deliverables. Triggers on "create PDF", "generate PDF", "PDF report", or any request for PDF output.
---

# PDF Document Creation

## When to use

- Create PDFs programmatically with reliable formatting
- Generate polished reports, summaries, deliverables as PDF
- Review and validate PDF rendering before delivery

## Dependencies

```bash
# Install if missing
pip install reportlab pdfplumber pypdf

# For rendering/review (macOS)
brew install poppler
```

## Workflow

### 1) Generate with reportlab

Use `reportlab` for PDF creation. Key capabilities:

- Page layouts, headers/footers, page numbers
- Tables, charts, images
- Consistent typography and spacing
- Professional margins and hierarchy

### 2) Extract/inspect with pdfplumber

Use `pdfplumber` or `pypdf` for reading existing PDFs and text extraction. Not reliable for layout fidelity.

### 3) Visual review

Render pages to PNGs and inspect:

```bash
pdftoppm -png input.pdf /tmp/pdf_render/page
```

### 4) Quality standards

- Polished design: consistent typography, spacing, margins, section hierarchy
- No clipped text, overlapping elements, broken tables, or black squares
- Charts, tables, and images must be sharp, aligned, and labeled
- Use ASCII hyphens only
- Re-render and inspect before delivery

## Output conventions

- Save final PDFs to the requesting agent's workspace or specified path
- Use descriptive filenames
- Clean up intermediate files after delivery
