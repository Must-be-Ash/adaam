# House Financial Disclosures — Official STOCK Act Data

Free. No API key. No scraping. Official government source. Updated daily.

This is the **primary source** — Capitol Trades, Quiver Quant, and everyone else gets their data from here.

## How It Works

Two-step process:

1. **Download the XML index** — a single ZIP file listing all filings for the year, updated daily
2. **Download individual PTR PDFs** by DocID — contains the actual trade details (ticker, buy/sell, amount, date)

No need to poll or scrape. Just re-download the ZIP periodically and diff against previously seen DocIDs.

## Step 1: Get the Filing Index

### Download

```bash
curl -s "https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2026FD.zip" \
  -H "User-Agent: Mozilla/5.0" \
  -o 2026FD.zip

unzip 2026FD.zip
# Produces: 2026FD.xml and 2026FD.txt
```

The URL pattern is `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{YEAR}FD.zip`

### XML Structure

```xml
<FinancialDisclosure>
  <Member>
    <Prefix>Hon.</Prefix>
    <Last>Allen</Last>
    <First>Richard W.</First>
    <Suffix />
    <FilingType>P</FilingType>      <!-- P = Periodic Transaction Report (stock trades) -->
    <StateDst>GA12</StateDst>
    <Year>2026</Year>
    <FilingDate>3/11/2026</FilingDate>
    <DocID>20034133</DocID>
  </Member>
  <!-- ... more members ... -->
</FinancialDisclosure>
```

### Filing Types

| Code | Meaning | Relevant? |
|---|---|---|
| **P** | **Periodic Transaction Report (PTR)** | **Yes — these are the stock trades** |
| A | Annual Financial Disclosure | Background info |
| C | Candidate report | No |
| W | Waiver/extension | No |
| X | Termination | No |

**Filter for `FilingType=P` only** — these are the STOCK Act trade disclosures.

### Parse the XML (Python)

```python
import xml.etree.ElementTree as ET

tree = ET.parse('2026FD.xml')
root = tree.getroot()

for member in root.findall('Member'):
    if member.find('FilingType').text == 'P':  # PTR only
        print({
            'name': f"{member.find('First').text} {member.find('Last').text}",
            'state': member.find('StateDst').text,
            'filing_date': member.find('FilingDate').text,
            'doc_id': member.find('DocID').text,
        })
```

### Example Output (110 PTR filings in 2026 so far)

```
1/15/2026  | Richard W. Allen      | GA12 | DocID: 20033751
2/17/2026  | Richard W. Allen      | GA12 | DocID: 20033945
3/11/2026  | Richard W. Allen      | GA12 | DocID: 20034133
2/19/2026  | Jake Auchincloss      | MA04 | DocID: 20034024
1/2/2026   | Donald Sternoff Beyer | VA08 | DocID: 20033714
2/22/2026  | Rob Bresnahan         | PA08 | DocID: 20034044
```

## Step 2: Get Trade Details from PDFs

### Download a PTR Filing

```bash
curl -s "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/{DOC_ID}.pdf" \
  -H "User-Agent: Mozilla/5.0" \
  -o filing.pdf
```

URL pattern: `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/{YEAR}/{DOC_ID}.pdf`

### What the PDF Contains

Each PTR PDF is a structured table with these fields per transaction:

| Field | Example | Description |
|---|---|---|
| Owner | SP | SP=Spouse, JT=Joint, DC=Dependent Child |
| Asset | Intuit Inc. - Common Stock (INTU) [ST] | Company name, ticker in parens, asset type code |
| Transaction Type | S or P | **S=Sale, P=Purchase** |
| Date | 02/19/2026 | When the trade happened |
| Notification Date | 03/05/2026 | When it was filed (reporting delay) |
| Amount | $1,001 - $15,000 | Value range bracket |
| Cap. Gains > $200? | Yes/No | Whether capital gains exceeded $200 |

### Example: Filing #20034133 (Hon. Richard W. Allen, GA12)

```
INTU  | S (sell)    | 02/19/2026 | $1,001 - $15,000
INTU  | S (sell)    | 02/18/2026 | $15,001 - $50,000
KMI   | P (buy)     | 02/19/2026 | $1,001 - $15,000
TSM   | P (buy)     | 02/19/2026 | $1,001 - $15,000
```

### Parsing the PDF

PDFs are structured but need PDF parsing. Options:
- **Python**: `PyPDF2`, `pdfplumber`, or `camelot` (table extraction)
- **AI/LLM**: Send the PDF to Claude for structured extraction
- **Pre-built**: Use the Apify scraper which already handles this

## Detecting New Filings (No Scraping Needed)

```python
import xml.etree.ElementTree as ET

# 1. Download the ZIP periodically (e.g. every 6 hours)
# 2. Parse XML and get all DocIDs with FilingType=P
# 3. Compare against previously seen DocIDs
# 4. For new DocIDs, download the PDF and parse trade details

seen_doc_ids = load_from_db()  # your persistent store

tree = ET.parse('2026FD.xml')
for member in tree.getroot().findall('Member'):
    if member.find('FilingType').text == 'P':
        doc_id = member.find('DocID').text
        if doc_id not in seen_doc_ids:
            # NEW FILING — download PDF and process
            download_and_parse_ptr(doc_id)
            seen_doc_ids.add(doc_id)
```

## Amount Range Brackets

Trades are reported in ranges, not exact amounts:

| Range |
|---|
| $1,001 - $15,000 |
| $15,001 - $50,000 |
| $50,001 - $100,000 |
| $100,001 - $250,000 |
| $250,001 - $500,000 |
| $500,001 - $1,000,000 |
| $1,000,001 - $5,000,000 |
| $5,000,001 - $25,000,000 |
| $25,000,001 - $50,000,000 |
| Over $50,000,000 |

## Rate Limits

No documented rate limits. This is a government website serving public data. Be respectful — don't hammer it. A few requests per minute is fine.

## Coverage

- **House members only** — Senate filings are at efdsearch.senate.gov (requires CSRF token, harder to access programmatically)
- Updated daily when new filings are submitted
- Data goes back years (change the year in the URL: 2025FD.zip, 2024FD.zip, etc.)

## Why This is the Best Source

| Source | Cost | Data Quality | Freshness | Scraping? |
|---|---|---|---|---|
| **House Clerk (this)** | Free | Primary source | Same day | No — just download ZIP |
| Capitol Trades | Free | Derived from this | Hours delay | Yes (RSC endpoint) |
| Quiver Quant | $10/mo | Derived from this | Hours delay | No (API) |
| Finnhub | Paid | Derived from this | Unknown delay | No (API) |

This is the source of truth. Everyone else copies from here.
