import boto3
import subprocess
import tempfile
import os
import json
import re

s3 = boto3.client('s3')

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
        
        # Create Lua filter for page breaks before each section
        lua_filter = '''
function Header(el)
  if el.level == 2 then
    return {pandoc.RawBlock('tex', '\\\\newpage'), el}
  end
  return el
end
'''
        lua_filter_path = os.path.join(tmp_dir, 'pagebreak.lua')
        with open(lua_filter_path, 'w') as f:
            f.write(lua_filter)
        
        # Run pandoc to generate PDF
        env = os.environ.copy()
        env['TEXMFVAR'] = '/tmp/texmf-var'
        
        result = subprocess.run([
            'pandoc',
            tmp_md_path,
            '-o', tmp_pdf_path,
            '--pdf-engine=xelatex',
            '-V', 'geometry:margin=1in',
            '-V', 'pagestyle=plain',
            '--from=markdown+hard_line_breaks',
            f'--lua-filter={lua_filter_path}',
            '--resource-path', tmp_dir
        ], capture_output=True, text=True, check=True, env=env)
        
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
