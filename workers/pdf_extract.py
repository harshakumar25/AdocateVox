"""LawBuddy PDF text extractor.

Usage: python -I pdf_extract.py <file.pdf>

Writes one JSON object per page to stdout (JSON Lines):
  {"page": 1, "width": 595.3, "height": 841.9,
   "lines": [{"text": "...", "x0": 72.0, "top": 90.1, "size": 10.5, "bold": false}, ...]}

Font size and boldness are kept so callers can tell headings, body text and
footnotes apart. The PDF is treated strictly as data: nothing in it is executed.
"""

import json
import statistics
import sys

import pdfplumber


def describe_line(line):
    chars = [c for c in line.get("chars", []) if c.get("text", "").strip()]
    sizes = [round(float(c["size"]), 1) for c in chars if "size" in c]
    bold_chars = sum(1 for c in chars if "bold" in str(c.get("fontname", "")).lower())
    return {
        "text": line["text"].strip(),
        "x0": round(float(line["x0"]), 1),
        "top": round(float(line["top"]), 1),
        "size": statistics.median(sizes) if sizes else None,
        "bold": bool(chars) and bold_chars * 2 > len(chars),
    }


def main(argv):
    if len(argv) != 2:
        print("usage: pdf_extract.py <file.pdf>", file=sys.stderr)
        return 2

    with pdfplumber.open(argv[1]) as pdf:
        for number, page in enumerate(pdf.pages, start=1):
            lines = [describe_line(line) for line in page.extract_text_lines(return_chars=True)]
            record = {
                "page": number,
                "width": round(float(page.width), 1),
                "height": round(float(page.height), 1),
                "lines": [line for line in lines if line["text"]],
            }
            sys.stdout.write(json.dumps(record, ensure_ascii=False) + "\n")
            page.flush_cache()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as error:  # report any parse failure to the caller on stderr
        print(f"pdf_extract failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
