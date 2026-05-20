# HLD PDF Generator Lambda

Lambda container function that automatically generates PDF from HLD markdown documents.

## Trigger

S3 event notification when `*/design/high_level_design.md` is created in the sessions bucket.

## Process

1. Receives S3 event notification
2. Downloads markdown file from S3
3. Runs pandoc with xelatex to generate PDF
4. Uploads PDF to same location (`.md` → `.pdf`)

## Dependencies

- Pandoc 3.1.11
- TeX Live with xelatex
- Python 3.12 (AWS Lambda base image)

## Output

PDF saved to: `s3://{bucket}/{session_id}/design/high_level_design.pdf`
