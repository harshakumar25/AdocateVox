"""LawBuddy fast page-text extractor (pdfium) for indexing judgments in bulk.

Usage:
  python -I pdf_text.py --tar            read a tar archive of PDFs from stdin (streamed)
  python -I pdf_text.py <file.pdf> ...   read PDF files
  python -I pdf_text.py --words <file>   positioned words, one JSON object per page

--words keeps columns apart: a Gazette Act prints its section headings in a
narrow margin column level with the body text, sometimes under 5 pt from it,
so a line extractor that joins everything on one baseline merges them into the
law. Each word carries x0, x1 and top (points from the top of the page), and
the caller assigns it to the body or the margin by position.

Writes one JSON object per PDF to stdout (JSON Lines):
  {"name": "2024_5_629_729_EN.pdf", "sha256": "...", "bytes": 568716, "pages": ["page 1 text", ...]}
or, when a PDF cannot be read:
  {"name": "...", "sha256": "...", "bytes": 123, "error": "..."}

Plain page text only (no positions): pdfium reads a 433-page report in about
1.5 s, which makes the whole Supreme Court record indexable on a laptop.
pdf_extract.py stays the tool for layout-aware parsing. Inputs are untrusted
data: the archive is read as a stream and never written to disk, members other
than regular .pdf files are skipped, and nothing in a PDF is executed.
"""

import hashlib
import json
import os
import sys
import tarfile

import pypdfium2 as pdfium

MAX_PDF_BYTES = 200 * 1024 * 1024


def page_texts(data):
    pdf = pdfium.PdfDocument(data)
    try:
        pages = []
        for index in range(len(pdf)):
            page = pdf[index]
            textpage = page.get_textpage()
            try:
                pages.append(textpage.get_text_bounded().replace("\r\n", "\n").replace("\r", "\n"))
            finally:
                textpage.close()
                page.close()
        return pages
    finally:
        pdf.close()


def emit(record):
    sys.stdout.write(json.dumps(record, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def describe(name, data):
    record = {"name": name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
    try:
        record["pages"] = page_texts(data)
    except Exception as error:  # one unreadable PDF must not stop the archive
        record["error"] = f"{type(error).__name__}: {error}"
    return record


def from_tar(stream):
    with tarfile.open(fileobj=stream, mode="r|") as archive:
        for member in archive:
            name = os.path.basename(member.name)
            # "._name.pdf" entries are macOS resource-fork metadata, not documents.
            if not member.isfile() or not name.lower().endswith(".pdf") or name.startswith("._"):
                continue
            if member.size > MAX_PDF_BYTES:
                emit({"name": name, "bytes": member.size, "error": "PDF larger than the size limit"})
                continue
            handle = archive.extractfile(member)
            if handle is None:
                continue
            emit(describe(name, handle.read()))
    # Read past the end-of-archive padding so the sender sees the whole stream consumed.
    while stream.read(1 << 20):
        pass


WORD_GAP = 2.0
LINE_TOLERANCE = 2.5


def page_words(page):
    """Positioned words of one page: split at spaces and at gaps wider than kerning."""
    textpage = page.get_textpage()
    try:
        height = page.get_size()[1]
        chars = []
        for index in range(textpage.count_chars()):
            char = textpage.get_text_range(index, 1)
            if not char or char in "\r\n":
                continue
            left, bottom, right, top = textpage.get_charbox(index, loose=True)
            if right - left < 0.5:
                continue  # zero-width characters pdfium generates at line ends land inside other lines
            chars.append((height - top, left, right, char))
        # Printed lines: characters whose tops lie within LINE_TOLERANCE of the line's first character.
        # (Rounding tops into fixed buckets would split a line whose glyphs straddle a bucket edge.)
        chars.sort(key=lambda c: c[0])
        lines = []
        for char in chars:
            if lines and char[0] - lines[-1][0][0] <= LINE_TOLERANCE:
                lines[-1].append(char)
            else:
                lines.append([char])
        words = []
        for line in lines:
            line.sort(key=lambda c: c[1])
            top = min(c[0] for c in line)
            current = None
            spaced = False
            for _, left, right, char in line:
                if char.isspace():
                    current = None
                    spaced = True
                    continue
                if current is None or left - current["x1"] > WORD_GAP:
                    # "sp": a space character precedes this word (loose glyph boxes can overlap the gap itself).
                    current = {"x0": left, "x1": right, "top": top, "text": "", "sp": spaced}
                    words.append(current)
                    spaced = False
                current["text"] += char
                current["x1"] = max(current["x1"], right)
        return [
            {"x0": round(w["x0"], 1), "x1": round(w["x1"], 1), "top": round(w["top"], 1), "text": w["text"], "sp": w["sp"]}
            for w in words
        ]
    finally:
        textpage.close()


def main(argv):
    if len(argv) == 3 and argv[1] == "--words":
        pdf = pdfium.PdfDocument(argv[2])
        try:
            for index in range(len(pdf)):
                page = pdf[index]
                try:
                    emit({"page": index + 1, "width": round(page.get_size()[0], 1), "words": page_words(page)})
                finally:
                    page.close()
        finally:
            pdf.close()
        return 0
    if argv[1:] == ["--tar"]:
        from_tar(sys.stdin.buffer)
        return 0
    if len(argv) < 2:
        print("usage: pdf_text.py --tar | --words <file.pdf> | <file.pdf> ...", file=sys.stderr)
        return 2
    for path in argv[1:]:
        with open(path, "rb") as handle:
            data = handle.read(MAX_PDF_BYTES + 1)
        name = os.path.basename(path)
        if len(data) > MAX_PDF_BYTES:
            emit({"name": name, "bytes": len(data), "error": "PDF larger than the size limit"})
            continue
        emit(describe(name, data))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as error:  # a broken archive stream is reported to the caller on stderr
        print(f"pdf_text failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
