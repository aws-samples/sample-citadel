#!/bin/bash
set -e

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Build frontend
echo "🔨 Building frontend..."
npm run build

echo "✅ Frontend build complete!"
echo "📁 Build artifacts saved to: build/"
echo ""
echo "💡 Next: Deploy backend which will pick up build/ folder"
