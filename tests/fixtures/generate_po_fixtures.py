#!/usr/bin/env python3
"""
Generate the canonical PO input fixtures used by integration tests.

Each fixture is a realistic textile-export PO in a different format:
  - email-basic.eml          plain text MIME, no attachments
  - email-with-image.eml     multipart/related with inline PNG carrying extra lines
  - email-revision.eml       second version of email-basic with qty change + new line
  - pdf-simple.pdf           1-page PDF rendered from plain text via cupsfilter
  - xlsx-basic.xlsx          spreadsheet with cells only
  - xlsx-with-image.xlsx     spreadsheet + xl/media image carrying extra lines
  - image-handwritten.png    standalone PNG (simulates a scanned/photographed PO)

Outputs are written to tests/fixtures/pos/inputs/ alongside the corresponding
*.expected.json assertion specs (which are hand-curated, not generated).

Run:
    python3 tests/fixtures/generate_po_fixtures.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import make_msgid

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("Missing Pillow: pip3 install Pillow")
try:
    from openpyxl import Workbook
    from openpyxl.drawing.image import Image as XLImage
except ImportError:
    sys.exit("Missing openpyxl: pip3 install openpyxl")

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "pos", "inputs")
os.makedirs(OUT, exist_ok=True)


# ── helpers ────────────────────────────────────────────────────────────────

def write(name: str, content: bytes | str, mode: str = "w") -> None:
    path = os.path.join(OUT, name)
    with open(path, "wb" if "b" in mode else "w") as f:
        f.write(content)
    print(f"  wrote {os.path.relpath(path, HERE)}")


def make_image_with_lines(lines: list[str], path: str, width: int = 720, height: int = 360) -> None:
    img = Image.new("RGB", (width, height), "white")
    d = ImageDraw.Draw(img)
    font = ImageFont.load_default()
    y = 20
    for ln in lines:
        d.text((20, y), ln, fill="black", font=font)
        y += 26
    img.save(path)


def text_to_pdf(text: str, out_path: str) -> None:
    """macOS-friendly: cupsfilter converts text/plain → PDF."""
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as t:
        t.write(text)
        txt_path = t.name
    try:
        with open(out_path, "wb") as out:
            subprocess.run(
                ["cupsfilter", "-i", "text/plain", "-m", "application/pdf", txt_path],
                check=True, stdout=out, stderr=subprocess.DEVNULL,
            )
    finally:
        os.unlink(txt_path)


# ── fixture: email-basic ───────────────────────────────────────────────────

def gen_email_basic() -> None:
    m = MIMEMultipart()
    m["Subject"] = "PO #FX-EMAIL-BASIC-001"
    m["From"] = "buyer@hm.com"
    m["To"] = "ofaem@unionfabrics.local"
    m["Message-ID"] = make_msgid(domain="hm.com")
    m.attach(MIMEText("""Dear Supplier,

Please confirm PO #FX-EMAIL-BASIC-001:

Date: 2026-05-13
Payment: LC 60 days
Currency: USD
Delivery: CIF Hamburg

LINE ITEMS:
1. Checkered cotton fabric 58 inches - 500 meters @ $2.50/m
2. Cotton yarn 40s natural - 100 kg @ $7.50/kg
3. White t-shirts adult large - 1500 pieces @ $1.80 each

Best regards,
HM Buying
""", "plain"))
    write("email-basic.eml", m.as_string())


# ── fixture: email-with-image (inline PNG carrying extra lines) ─────────────

def gen_email_with_image() -> None:
    png_path = os.path.join(OUT, "_tmp_email_image.png")
    make_image_with_lines([
        "ADDITIONAL LINE ITEMS (image-only):",
        "",
        "  4. Trousers adult medium khaki - 400 pieces @ $4.40/piece",
        "  5. Buttons 4-hole 12mm - 5000 pcs @ $0.05 each",
    ], png_path)

    m = MIMEMultipart("related")
    m["Subject"] = "PO #FX-EMAIL-IMG-001"
    m["From"] = "buyer@hm.com"
    m["To"] = "ofaem@unionfabrics.local"
    m["Message-ID"] = make_msgid(domain="hm.com")
    m.attach(MIMEText("""Dear Supplier,

PO #FX-EMAIL-IMG-001
Date: 2026-05-13
Payment: TT 30 days
Currency: USD

Body items:
1. Checkered cotton fabric 58 inches - 800 meters @ $2.55/m
2. Cotton yarn 40s natural - 150 kg @ $7.60/kg

Additional items in attached image.
""", "plain"))
    with open(png_path, "rb") as f:
        img = MIMEImage(f.read(), _subtype="png")
    img.add_header("Content-ID", "<additional-items>")
    img.add_header("Content-Disposition", "inline", filename="additional-items.png")
    m.attach(img)
    write("email-with-image.eml", m.as_string())
    os.unlink(png_path)


# ── fixture: email-revision (revision of email-basic) ───────────────────────

def gen_email_revision() -> None:
    m = MIMEMultipart()
    m["Subject"] = "REVISED PO #FX-EMAIL-BASIC-001"
    m["From"] = "buyer@hm.com"
    m["To"] = "ofaem@unionfabrics.local"
    m["Message-ID"] = make_msgid(domain="hm.com")
    m.attach(MIMEText("""Dear Supplier,

Revised PO #FX-EMAIL-BASIC-001 (replaces previous):

Date: 2026-05-13
Payment: LC 60 days
Currency: USD
Delivery: CIF Hamburg

LINE ITEMS:
1. Checkered cotton fabric 58 inches - 750 meters @ $2.50/m   (qty: 500 -> 750)
2. Cotton yarn 40s natural - 100 kg @ $7.75/kg                (price: 7.50 -> 7.75)
3. White t-shirts adult large - 1500 pieces @ $1.80 each
4. Trousers adult medium khaki - 600 pieces @ $4.40 each      (NEW LINE)

Best regards,
HM Buying
""", "plain"))
    write("email-revision.eml", m.as_string())


# ── fixture: pdf-simple ─────────────────────────────────────────────────────

def gen_pdf_simple() -> None:
    if shutil.which("cupsfilter") is None:
        print("  (skipping pdf-simple.pdf: cupsfilter not available)")
        return
    text = """PURCHASE ORDER

PO #: FX-PDF-001
Date: 2026-05-13
Buyer: H&M Sweden
Delivery: CIF Hamburg, Germany
Payment Terms: LC 60 days
Currency: USD

LINE ITEMS:
1. Checkered cotton fabric 58 inches - 1200 meters @ $2.85/meter
2. Cotton yarn 40s natural - 300 kg @ $7.75/kg
3. T-shirts adult large white - 5000 pieces @ $1.95 each
4. Trousers adult medium khaki - 2000 pieces @ $4.50 each
"""
    text_to_pdf(text, os.path.join(OUT, "pdf-simple.pdf"))
    print(f"  wrote {os.path.relpath(os.path.join(OUT, 'pdf-simple.pdf'), HERE)}")


# ── fixture: xlsx-basic ─────────────────────────────────────────────────────

def gen_xlsx_basic() -> None:
    wb = Workbook(); ws = wb.active
    ws.append(["PO #", "FX-XLSX-001"])
    ws.append(["Date", "2026-05-13"])
    ws.append(["Payment", "TT 45 days"])
    ws.append(["Currency", "USD"])
    ws.append([])
    ws.append(["SKU", "Description", "Qty", "Unit", "Price"])
    ws.append(["", "Checkered cotton 58 inch", 900, "meters", 2.60])
    ws.append(["", "Cotton yarn 40s natural", 200, "kg", 7.80])
    ws.append(["", "White t-shirts adult large", 3000, "pieces", 1.85])
    wb.save(os.path.join(OUT, "xlsx-basic.xlsx"))
    print("  wrote pos/inputs/xlsx-basic.xlsx")


# ── fixture: xlsx-with-image ────────────────────────────────────────────────

def gen_xlsx_with_image() -> None:
    png_path = os.path.join(OUT, "_tmp_xlsx_image.png")
    make_image_with_lines([
        "Extra line items (image embedded in spreadsheet):",
        "",
        "  4. Trousers adult medium khaki - 400 pcs @ $4.40",
        "  5. Buttons 4-hole 12mm - 5000 pcs @ $0.05",
    ], png_path, width=620)

    wb = Workbook(); ws = wb.active
    ws.append(["PO #", "FX-XLSX-IMG-001"])
    ws.append(["Date", "2026-05-13"])
    ws.append(["Payment", "LC 60 days"])
    ws.append(["Currency", "USD"])
    ws.append([])
    ws.append(["SKU", "Description", "Qty", "Unit", "Price"])
    ws.append(["", "Checkered cotton 58 inch", 700, "meters", 2.95])
    ws.append(["", "Cotton yarn 40s natural", 180, "kg", 7.65])
    ws.append([])
    ws.append(["SEE EMBEDDED IMAGE FOR ADDITIONAL ITEMS"])
    ws.add_image(XLImage(png_path), "A12")
    wb.save(os.path.join(OUT, "xlsx-with-image.xlsx"))
    print("  wrote pos/inputs/xlsx-with-image.xlsx")
    # Note: openpyxl copies the image into the zip; the temp file can be deleted.
    os.unlink(png_path)


# ── fixture: image-handwritten (standalone PNG) ─────────────────────────────

def gen_image_handwritten() -> None:
    make_image_with_lines([
        "PURCHASE ORDER  #FX-IMG-001",
        "",
        "Date: 2026-05-13",
        "Buyer: Indie Fashion Co.",
        "Payment: TT 30 days   Currency: USD",
        "",
        "1. Cotton yarn 40s natural - 250 kg @ $7.50/kg",
        "2. White t-shirts adult large - 800 pcs @ $1.85 each",
        "3. Trousers adult medium khaki - 300 pcs @ $4.30 each",
    ], os.path.join(OUT, "image-handwritten.png"), width=820, height=400)
    print("  wrote pos/inputs/image-handwritten.png")


# ── main ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"Generating PO fixtures under {OUT}")
    gen_email_basic()
    gen_email_with_image()
    gen_email_revision()
    gen_pdf_simple()
    gen_xlsx_basic()
    gen_xlsx_with_image()
    gen_image_handwritten()
    print("done.")
