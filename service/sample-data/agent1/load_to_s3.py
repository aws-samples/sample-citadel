import boto3
import json
import os

def load_guidelines_to_s3():
    s3_client = boto3.client('s3')
    bucket_name = os.environ['ASSESSMENT_BUCKET']
    
    # Mapping of files to dimensions
    files = {
        'technical_assessment_guidelines.json': 'technical',
        'business_assessment_guidelines.json': 'business', 
        'commercial_assessment_guidelines.json': 'commercial',
        'governance_assessment_guidelines.json': 'governance'
    }
    
    for filename, dimension in files.items():
        # Load the JSON file
        with open(filename, 'r') as f:
            data = json.load(f)
        
        # Create index entries
        index_entries = []
        
        # Process each category
        for category in data['categories']:
            category_title = category['category']
            category_key = f"{dimension}/{category_title.replace(' ', '_').replace('&', 'and')}"
            
            # Add to index
            index_entries.append({
                'title': category_title,
                'key': category_key
            })
            
            # Create category file content
            category_content = {
                'points_to_extract': category['points_to_extract'],
                'sample_questions': category['sample_questions']
            }
            
            # Upload category file
            s3_client.put_object(
                Bucket=bucket_name,
                Key=category_key,
                Body=json.dumps(category_content, indent=2),
                ContentType='application/json'
            )
            print(f"Uploaded: {category_key}")
        
        # Upload index file
        index_key = f"{dimension}/index"
        s3_client.put_object(
            Bucket=bucket_name,
            Key=index_key,
            Body=json.dumps(index_entries, indent=2),
            ContentType='application/json'
        )
        print(f"Uploaded index: {index_key}")

if __name__ == "__main__":
    load_guidelines_to_s3()
    print("All assessment guidelines loaded to S3")
