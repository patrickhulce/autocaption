
import sys
import json
from transformers import pipeline


def main():
    image_to_text = pipeline(
        "image-to-text", model="nlpconnect/vit-gpt2-image-captioning")
    caption = image_to_text(sys.argv[1])
    print(json.dumps(caption))


if __name__ == "__main__":
    main()
