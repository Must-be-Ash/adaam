# House hybrid-recovery production regression

`ptr-8221360.pdf` is the public House Clerk filing captured on 2026-08-28 from
`https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/8221360.pdf`.
Its SHA-256 digest is
`106083fc58815d570a6f4128e6f76d9e791d38707f55275b9c5686dd35179d3a`.

The image-only filing is retained solely to exercise PDF.js's runtime-loaded
JBIG2 decoder. Verification checks that the bounded page renderer produces
visible pixels instead of a white image; it does not assert or reinterpret the
filing's financial contents. Normal verification is offline and does not
download the source again.
