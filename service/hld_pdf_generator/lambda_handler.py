import boto3
import subprocess
import tempfile
import os
import json
import re

s3 = boto3.client('s3')

# ---------- Security: Pandoc markdown input format ----------
# Disable raw_tex, raw_html, and raw_attribute extensions so LLM-generated
# markdown cannot inject TeX commands (\input, \write18) or HTML into the
# xelatex pipeline.  This is defence layer 1 of 4 (see build_pandoc_command).
PANDOC_INPUT_FORMAT = 'markdown+hard_line_breaks-raw_tex-raw_html-raw_attribute'


def write_lua_filter(tmp_dir):
    """Write a Lua filter that inserts page breaks before H2 headers and
    strips any raw TeX/HTML blocks that survive the input-format restriction
    (defence layer 3 — belt-and-suspenders)."""
    lua_filter = r'''
-- Defence layer 3: strip raw blocks/inlines regardless of format flags
function RawBlock(el)
  if el.format == 'tex' or el.format == 'latex' or el.format == 'html' then
    return {}
  end
  return el
end

function RawInline(el)
  if el.format == 'tex' or el.format == 'latex' or el.format == 'html' then
    return {}
  end
  return el
end

function Header(el)
  if el.level == 2 then
    return {pandoc.RawBlock('tex', '\\newpage'), el}
  end
  return el
end
'''
    lua_filter_path = os.path.join(tmp_dir, 'pagebreak.lua')
    with open(lua_filter_path, 'w') as f:
        f.write(lua_filter)
    return lua_filter_path


def build_pandoc_command(md_path, pdf_path, lua_filter_path, resource_dir):
    """Build the pandoc argv list with all security flags.

    Defence layers:
      1. Input format disables raw_tex / raw_html / raw_attribute.
      2. --pdf-engine-opt=-no-shell-escape prevents \\write18 shell execution.
      3. Lua filter strips surviving RawBlock / RawInline nodes.
      4. openin_any / openout_any env vars (see build_pandoc_env) restrict
         TeX file access to the working tree.
    """
    return [
        'pandoc',
        md_path,
        '-o', pdf_path,
        '--pdf-engine=xelatex',
        '--pdf-engine-opt=-no-shell-escape',
        '-V', 'geometry:margin=1in',
        '-V', 'pagestyle=plain',
        f'--from={PANDOC_INPUT_FORMAT}',
        f'--lua-filter={lua_filter_path}',
        '--resource-path', resource_dir,
    ]


def build_pandoc_env():
    """Return the environment dict for the pandoc subprocess.

    Defence layer 4: restrict TeX's file-open scope so even if a raw TeX
    command slips through, xelatex cannot read files outside the working tree
    (openin_any=p) or write outside it (openout_any=p).
    """
    env = os.environ.copy()
    env['TEXMFVAR'] = '/tmp/texmf-var'
    # Paranoid mode: TeX may only open files under the working directory
    env['openin_any'] = 'p'
    env['openout_any'] = 'p'
    return env

def extract_and_render_dot_diagrams(markdown_content, tmp_dir):
    """
    Extract DOT code blocks, render to SVG using graphviz, and replace with image references.
    """
    dot_pattern = r'```dot\n(.*?)\n```'
    matches = re.findall(dot_pattern, markdown_content, re.DOTALL)
    
    for i, dot_code in enumerate(matches):
        dot_file = os.path.join(tmp_dir, f'diagram_{i}.dot')
        svg_file = os.path.join(tmp_dir, f'diagram_{i}.svg')
        
        # Write DOT code to file
        with open(dot_file, 'w') as f:
            f.write(dot_code)
        
        # Render to SVG using graphviz
        try:
            subprocess.run([
                'dot',
                '-Tsvg',
                dot_file,
                '-o', svg_file
            ], check=True, capture_output=True, text=True)
            
            # Replace DOT code block with image reference
            markdown_content = markdown_content.replace(
                f'```dot\n{dot_code}\n```',
                f'![Diagram](diagram_{i}.svg)',
                1
            )
        except subprocess.CalledProcessError as e:
            print(f"Warning: Failed to render diagram {i}: {e.stderr}")
    
    return markdown_content

def handler(event, context):
    """
    Lambda handler triggered by S3 event when high_level_design.md is created.
    Generates PDF from markdown using pandoc.
    """
    print(f"Event: {json.dumps(event)}")
    
    try:
        # Parse S3 event
        record = event['Records'][0]
        bucket = record['s3']['bucket']['name']
        key = record['s3']['object']['key']
        
        print(f"Processing: s3://{bucket}/{key}")
        
        # Validate it's a markdown file
        if not key.endswith('.md'):
            print(f"Skipping non-markdown file: {key}")
            return {'statusCode': 200, 'body': 'Skipped'}
        
        # Create temp directory for diagrams
        tmp_dir = tempfile.mkdtemp()
        
        # Download markdown from S3
        response = s3.get_object(Bucket=bucket, Key=key)
        markdown_content = response['Body'].read().decode('utf-8')
        
        # Extract and render DOT diagrams
        markdown_content = extract_and_render_dot_diagrams(markdown_content, tmp_dir)
        
        # Write processed markdown to temp file
        tmp_md_path = os.path.join(tmp_dir, 'input.md')
        with open(tmp_md_path, 'w') as f:
            f.write(markdown_content)
        
        # Generate PDF path
        tmp_pdf_path = os.path.join(tmp_dir, 'output.pdf')
        
        lua_filter_path = write_lua_filter(tmp_dir)
        
        # Run pandoc to generate PDF
        cmd = build_pandoc_command(tmp_md_path, tmp_pdf_path, lua_filter_path, tmp_dir)
        env = build_pandoc_env()
        
        result = subprocess.run(
            cmd, capture_output=True, text=True, check=True, env=env
        )
        
        print(f"Pandoc output: {result.stdout}")
        
        # Upload PDF to S3
        pdf_key = key.replace('.md', '.pdf')
        with open(tmp_pdf_path, 'rb') as pdf_file:
            s3.put_object(
                Bucket=bucket,
                Key=pdf_key,
                Body=pdf_file.read(),
                ContentType='application/pdf'
            )
        
        print(f"✅ PDF generated: s3://{bucket}/{pdf_key}")
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'PDF generated successfully',
                'pdf_location': f's3://{bucket}/{pdf_key}'
            })
        }
        
    except subprocess.CalledProcessError as e:
        print(f"❌ Pandoc error: {e.stderr}")
        raise
    except Exception as e:
        print(f"❌ Error: {str(e)}")
        raise
