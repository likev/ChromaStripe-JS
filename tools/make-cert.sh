#!/usr/bin/env bash
# Generates self-signed SSL certificates for LAN testing on mobile devices
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEY="$DIR/key.pem"
CERT="$DIR/cert.pem"

echo "Generating self-signed SSL certificate for ChromaStripe-JS..."
openssl req -x509 -newkey rsa:2048 -keyout "$KEY" -out "$CERT" -days 365 -nodes \
  -subj "/CN=chromastripe.local" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:0.0.0.0"

echo "SSL Certificate generated at:"
echo "  $KEY"
echo "  $CERT"
