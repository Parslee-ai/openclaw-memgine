---
name: transcribe-diarize
description: Transcribe audio files to text with optional speaker diarization (speaker labels). Use when transcribing interviews, meetings, podcasts, or any multi-speaker audio. Upgrades basic transcription with speaker identification. Triggers on "transcribe with speakers", "diarize", "who said what", "interview transcript", or any transcription needing speaker labels.
---

# Audio Transcription with Speaker Diarization

## When to use

- Transcribe audio with speaker identification (interviews, meetings, podcasts)
- Fast single-speaker transcription
- Any audio-to-text where knowing who spoke matters

## Prerequisites

- `OPENAI_API_KEY` must be set
- Python 3 available

```bash
pip install openai
```

## Quick Start

### Fast transcription (no speakers)

```bash
python3 ~/openclaw/skills/transcribe-diarize/scripts/transcribe_diarize.py audio.mp3
```

### With speaker diarization

```bash
python3 ~/openclaw/skills/transcribe-diarize/scripts/transcribe_diarize.py audio.mp3 \
  --model gpt-4o-transcribe-diarize \
  --response-format diarized_json
```

### With known speaker hints

```bash
python3 ~/openclaw/skills/transcribe-diarize/scripts/transcribe_diarize.py audio.mp3 \
  --model gpt-4o-transcribe-diarize \
  --response-format diarized_json \
  --speakers "Keenan,Dr. Smith"
```

## Options

| Flag                  | Default                  | Description                                 |
| --------------------- | ------------------------ | ------------------------------------------- |
| `--model`             | `gpt-4o-mini-transcribe` | Model to use                                |
| `--response-format`   | `text`                   | `text`, `json`, or `diarized_json`          |
| `--language`          | auto                     | Language hint (ISO code)                    |
| `--chunking-strategy` | `auto`                   | For audio >30s                              |
| `--speakers`          | none                     | Comma-separated known speaker names (max 4) |
| `--out-dir`           | stdout                   | Output directory                            |
| `--dry-run`           | false                    | Validate without API call                   |

## Decision Rules

- **Fast transcription:** `gpt-4o-mini-transcribe` + `--response-format text`
- **Speaker labels needed:** `gpt-4o-transcribe-diarize` + `--response-format diarized_json`
- **Audio >30s:** Keep `--chunking-strategy auto`
- **Prompting not supported** for the diarize model

## API Reference

See `~/openclaw/skills/transcribe-diarize/references/api.md` for full API details.

## Notes

- Max audio size: 25MB per file
- Max known speakers: 4
- Supported formats: mp3, mp4, mpeg, mpga, m4a, wav, webm
