#!/bin/bash

# Create PDF output directory if it doesn't exist
mkdir -p pdf

# Convert all .md files to PDF
for md_file in *.md; do
    if [ -f "$md_file" ]; then
        pdf_file="../pdf/${md_file%.md}.pdf"
        echo "Converting $md_file to $pdf_file..."
        pandoc "$md_file" -o "$pdf_file" 
    fi
done

echo "✅ Conversion complete! PDFs saved in pdf/ directory"
