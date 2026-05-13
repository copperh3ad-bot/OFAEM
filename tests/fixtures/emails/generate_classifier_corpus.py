#!/usr/bin/env python3
"""
Generate the classifier-corpus fixtures used by tests/integration/classifier.test.ts.

Outputs 10 PO emails and 10 non-PO emails into tests/fixtures/emails/{po,not_po}/.
Each .eml is a realistic textile-supplier inbox sample; together they cover
the classifier's confusion frontier (RFQs, status inquiries, sample requests,
invoices, marketing, etc).
"""

from __future__ import annotations

import os
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import make_msgid

HERE = os.path.dirname(os.path.abspath(__file__))
PO_DIR = os.path.join(HERE, "po")
NOT_PO_DIR = os.path.join(HERE, "not_po")
os.makedirs(PO_DIR, exist_ok=True)
os.makedirs(NOT_PO_DIR, exist_ok=True)


def write_email(folder: str, name: str, subject: str, from_addr: str, body: str) -> None:
    m = MIMEMultipart()
    m["Subject"] = subject
    m["From"] = from_addr
    m["To"] = "orders@unionfabrics.local"
    m["Message-ID"] = make_msgid(domain=from_addr.split("@", 1)[-1])
    m.attach(MIMEText(body, "plain"))
    path = os.path.join(folder, name)
    with open(path, "w") as f:
        f.write(m.as_string())
    print(f"  {os.path.relpath(path, HERE)}")


# ── 10 POSITIVE emails (should classify as PO with confidence >= 0.65) ─────

PO_EMAILS = [
    ("p01.eml", "PO #HM-2026-9001", "buyer@hm.com", """\
Dear Supplier,

Please confirm PO #HM-2026-9001.

Date: 2026-05-14   Payment: LC 60 days   Currency: USD
Delivery: CIF Hamburg

1. Checkered cotton fabric 58 inch — 500 m @ $2.50/m
2. Cotton yarn 40s natural — 100 kg @ $7.50/kg
3. White T-shirts adult large — 1500 pcs @ $1.80 each

Regards,
HM Buying
"""),
    ("p02.eml", "Order Confirmation — Inditex Q2", "merch@inditex.com", """\
Hi team,

Order confirmation attached values (text below for the record):

PO number: ZARA-Q2-44102
Currency: EUR
Payment: TT 30 days
Incoterm: FOB Karachi

Items:
- Polo shirts adult medium — 4000 pcs @ EUR 3.80
- Trousers adult large khaki — 2000 pcs @ EUR 6.20

Need confirmation by EOD Friday.

Inditex
"""),
    ("p03.eml", "PO# COTTON-ON-0823 reissued", "purchasing@cottonon.com", """\
PO number COTTON-ON-0823 (replaces -0822, cancelled).

Date: 2026-05-15
Payment: TT 45 days   Currency: AUD
Delivery: DDP Melbourne

Line items:
1) Denim 12oz indigo — 2500 m @ AUD 4.20
2) Cotton yarn 30s — 400 kg @ AUD 8.00
3) Button 4-hole 12mm — 25000 pcs @ AUD 0.05

Best,
Cotton On Procurement
"""),
    ("p04.eml", "Confirmed: PO 99887766", "ops@uniqlo.com", """\
Confirming PO 99887766.

Buyer: Uniqlo Japan KK
Currency: JPY
Payment: LC at sight
Incoterms: CIF Yokohama
Ship-by: 2026-08-15

3000 pcs T-shirt round neck white adult large @ JPY 480
1500 pcs Polo shirt navy adult medium @ JPY 950

Confirm receipt.
"""),
    ("p05.eml", "Revised PO #NEXT-RX-7741", "purchasing@next.co.uk", """\
REVISED PO #NEXT-RX-7741

Date: 2026-05-14
Currency: GBP
Payment: CAD
Delivery: FOB Karachi

Originally 5,000 pcs T-shirts; revised quantities:
1. T-shirt adult large white — 7,500 pcs @ GBP 1.40
2. T-shirt adult medium black — 5,000 pcs @ GBP 1.40
3. NEW: Trousers adult large navy — 2,000 pcs @ GBP 3.90

Note: bullet 3 was added per call with Sarah.

Next plc Buying
"""),
    ("p06.eml", "PO confirmation IM-9988 (small order)", "buyer@indie-fashion.shop", """\
Hi,

Confirming small order. Please process PO IM-9988:

Currency: USD   Payment: TT 30 days   Delivery: EXW Karachi

Item: cotton yarn 40s natural, 50 kg, $8/kg.
That's USD 400 total.

Thanks,
Indie Fashion (gmail-relayed)
"""),
    ("p07.eml", "PO HM-2026-9002 — see attached", "buyer@hm.com", """\
Hi,

PO HM-2026-9002 attached as PDF. Body summary:

Date 2026-05-15   Payment LC 60d   Currency USD   Dest: CIF Hamburg

- Fabric 58inch checkered, 900 m, $2.55/m
- Yarn 40s cotton, 200 kg, $7.75/kg
- T-shirts adult large white, 4000 pcs, $1.85 each

Please confirm by tomorrow.
"""),
    ("p08.eml", "Order: BERSHKA-Q3-12 (excel attached + summary)", "buying@bershka.com", """\
Order BERSHKA-Q3-12 — spreadsheet attached, body summary below for the record.

Currency: EUR
Payment: TT 60 days
Inc: CIF Barcelona

Line summary (full breakdown in spreadsheet):
1. Denim 12oz indigo — 3,000 m @ EUR 3.80
2. Cotton yarn 30s — 250 kg @ EUR 6.40
3. T-shirts adult medium black — 4,000 pcs @ EUR 1.30
4. Trim buttons 4-hole — 50,000 pcs @ EUR 0.04

Approx. total EUR 18,400. Please confirm receipt and ship-date by Friday.

Bershka Buying
"""),
    ("p09.eml", "PO # UQ-FW26-441 (handwritten copy attached)", "ops@uniqlo.com", """\
The handwritten PO copy is attached as scanned image. Key text:

PO UQ-FW26-441   Currency JPY   Payment LC at sight
Delivery CIF Yokohama 2026-09-30

Polo, navy, M, 2000 pcs, ¥950
T-shirt, white, L, 4000 pcs, ¥480

Please confirm.

Uniqlo Operations
"""),
    ("p10.eml", "BOUTIQUE-X PO #BX-44 — small but urgent", "orders@boutique-x.co", """\
Hi,

Need urgent confirmation of PO #BX-44.

Items:
- White t-shirts adult large, 200 pcs at $2.10 each
- Trousers khaki adult medium, 150 pcs at $4.80 each

Currency USD, payment TT 14 days, delivery EXW Karachi by 2026-06-30.

Total around USD 1,140. Please reply with confirmation.

Boutique X Buying
"""),
]


# ── 10 NEGATIVE emails (should classify as NOT_PO with confidence <= 0.5) ──

NOT_PO_EMAILS = [
    ("n01.eml", "PO #HM-2026-9001 — shipment status?", "logistics@hm.com", """\
Hi team,

Can you share the current shipment status of PO #HM-2026-9001?
Our DC is asking for an ETA. No need to reconfirm items, just the
ship date and the BL number when ready.

Thanks,
HM Logistics
"""),
    ("n02.eml", "Quotation request — denim 12oz", "sourcing@inditex.com", """\
Hello,

Could you share your best CIF price for 12oz indigo denim, target volume
2,500 to 4,000 meters? We are early in costing, not placing an order yet.
A response by EOW would be appreciated. No commitment from our side.

Best,
Inditex Sourcing
"""),
    ("n03.eml", "Sample request — polo pique", "samples@cottonon.com", """\
Hi,

Please courier 2 samples in size M of the polo pique reference UF-POLO-PQ.
We will pay the courier on arrival. No volume commitment yet — this is for
design review.

Cotton On Sampling team
"""),
    ("n04.eml", "Invoice #INV-2026-115 — payment reminder", "ar@unionfabrics.com", """\
Dear Accounts,

Please settle invoice #INV-2026-115, USD 12,800, due 2026-05-10. The
underlying PO HM-2026-9001 already shipped.

Wire details unchanged.

Union Fabrics AR
"""),
    ("n05.eml", "Newsletter: Spring 2026 fabric trends", "newsletter@textilenews.com", """\
Hi friends,

Check out our latest report on Spring 2026 fabric trends — checkered
cotton is back. Click here for the full deck. (newsletter — unsubscribe at the bottom)

TextileNews
"""),
    ("n06.eml", "Complaint: color mismatch on prior PO 8801", "qc@bershka.com", """\
Hi team,

The fabric received against PO 8801 is off-shade by Delta-E 4.5. We need
a corrective action plan and a no-charge re-shipment of 200m. Please advise.

Bershka QC
"""),
    ("n07.eml", "Re: shipment 88 — pricing dispute", "ap@uniqlo.com", """\
Hi,

We're disputing line 3 on commercial invoice 8088. The unit price was
agreed at JPY 460, not 480. We need a credit note before we release payment.
No new order details here — this is a reconciliation thread.

Uniqlo AP
"""),
    ("n08.eml", "Auto-reply: Out of office", "buyer@next.co.uk", """\
I'm out until 2026-05-20. Please direct urgent matters to my colleague
james.brown@next.co.uk. I'll respond to non-urgent items on my return.

Sarah / Next plc Buying
"""),
    ("n09.eml", "Re: factory audit schedule for June", "audit@uniqlo.com", """\
Hi team,

To finalize the schedule for the social compliance audit in June, can you
share availability for the 2nd through 6th? We'll bring two auditors.
No PO impact, just calendar coordination.

Uniqlo Sustainability
"""),
    ("n10.eml", "Cold sales pitch — yarn supplier intro", "sales@yarnsupplierxyz.com", """\
Dear procurement,

We are a yarn manufacturer offering competitive pricing on combed cotton
20s/40s. Attached our 2026 price list and a catalog. Happy to set up a
call. Please consider us for your upcoming purchase orders.

YarnSupplierXYZ sales
"""),
]


if __name__ == "__main__":
    print("Generating PO emails …")
    for name, subj, frm, body in PO_EMAILS:
        write_email(PO_DIR, name, subj, frm, body)
    print("\nGenerating NOT_PO emails …")
    for name, subj, frm, body in NOT_PO_EMAILS:
        write_email(NOT_PO_DIR, name, subj, frm, body)
    print(f"\nDone. {len(PO_EMAILS)} PO + {len(NOT_PO_EMAILS)} non-PO.")
