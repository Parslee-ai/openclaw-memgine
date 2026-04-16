---
name: spreadsheet-create
description: Create, edit, and analyze spreadsheets (.xlsx, .csv, .tsv) with formula-aware workflows. Use when tasks involve generating data tables, analysis outputs, formatted Excel reports, or any tabular data deliverable. Triggers on "create spreadsheet", "Excel report", "data export", "generate CSV", "analysis table".
---

# Spreadsheet Creation & Analysis

## When to use

- Create workbooks with formulas, formatting, and structured layouts
- Analyze tabular data (filter, aggregate, pivot, compute metrics)
- Modify existing workbooks without breaking formulas or formatting
- Generate charts and summary tables
- Export analysis results as formatted Excel or CSV

## Dependencies

```bash
pip install openpyxl pandas
```

## Example Code

Reference examples at `~/openclaw/skills/spreadsheet-create/references/examples/openpyxl/`:

- `create_basic_spreadsheet.py` — Basic workbook creation
- `create_spreadsheet_with_styling.py` — Styled workbook with formatting
- `styling_spreadsheet.py` — Styling patterns
- `read_existing_spreadsheet.py` — Reading and modifying existing files

## Workflow

### 1) Choose your tool

- **openpyxl** for creating/editing .xlsx with formatting and formulas
- **pandas** for analysis, CSV/TSV workflows, then write results back to .xlsx or .csv
- **openpyxl.chart** for native Excel charts

### 2) Key principles

- Use **formulas** for derived values — don't hardcode calculated results
- Preserve formatting when editing existing workbooks
- Style headers, use number formats, set column widths

### 3) Quality standards

- Clean, professional layouts
- Formulas, not hardcoded values, for computed cells
- Proper number formats (currency, percentages, dates)
- Descriptive sheet names and headers
- Freeze panes for large datasets

## Output conventions

- Save to requesting agent's workspace or specified path
- Use descriptive filenames
- Default to .xlsx unless CSV/TSV specifically requested
