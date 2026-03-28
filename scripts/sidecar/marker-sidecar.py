#!/usr/bin/env python3
"""
Marker PDF Sidecar — V25.8.7
Persistent process that converts PDFs to Markdown using Marker.

Protocol (stdin/stdout):
  IN:  /tmp/booster-2401.00001.pdf\n
  OUT: <MARKER_START>\n...markdown...\n<MARKER_END>\n
  ERR: <MARKER_ERROR>\n

Loads model once at startup. Runs gc.collect() between conversions.
"""

import sys
import gc
import signal

# Graceful shutdown on SIGTERM
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

def load_marker():
    """Load Marker model once."""
    try:
        from marker.converters.pdf import PdfConverter
        from marker.models import create_model_dict
        from marker.config.parser import ConfigParser
        config = ConfigParser({})
        artifact_dict = create_model_dict()
        converter = PdfConverter(
            config=config.generate_config_dict(),
            artifact_dict=artifact_dict,
        )
        sys.stderr.write("[MARKER] Model loaded successfully.\n")
        sys.stderr.flush()
        return converter
    except Exception as e:
        sys.stderr.write(f"[MARKER] Failed to load model: {e}\n")
        sys.stderr.flush()
        return None

def convert_pdf(converter, pdf_path):
    """Convert a single PDF to Markdown."""
    try:
        result = converter(pdf_path)
        # result is (rendered_text, metadata, images) tuple
        if isinstance(result, tuple):
            markdown = result[0]
        else:
            markdown = str(result)
        return markdown if markdown and len(markdown) > 50 else None
    except Exception as e:
        sys.stderr.write(f"[MARKER] Conversion error: {e}\n")
        sys.stderr.flush()
        return None

def main():
    sys.stderr.write("[MARKER] Sidecar starting...\n")
    sys.stderr.flush()

    converter = load_marker()
    if not converter:
        sys.stderr.write("[MARKER] No converter available. Exiting.\n")
        sys.stderr.flush()
        sys.exit(1)

    sys.stderr.write("[MARKER] Ready. Waiting for PDF paths on stdin.\n")
    sys.stderr.flush()

    for line in sys.stdin:
        pdf_path = line.strip()
        if not pdf_path:
            continue

        markdown = convert_pdf(converter, pdf_path)

        if markdown:
            sys.stdout.write(f"<MARKER_START:{pdf_path}>\n")
            sys.stdout.write(markdown)
            if not markdown.endswith("\n"):
                sys.stdout.write("\n")
            sys.stdout.write(f"<MARKER_END:{pdf_path}>\n")
        else:
            sys.stdout.write(f"<MARKER_ERROR:{pdf_path}>\n")

        sys.stdout.flush()

        # Memory cleanup between conversions
        gc.collect()

if __name__ == "__main__":
    main()
