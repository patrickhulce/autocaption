
import sys
import json
from transformers import TrOCRProcessor, VisionEncoderDecoderModel
from PIL import Image


def main():
  processor = TrOCRProcessor.from_pretrained("microsoft/trocr-base-handwritten")
  model = VisionEncoderDecoderModel.from_pretrained("microsoft/trocr-base-handwritten")

  image = Image.open(sys.argv[1]).convert("RGB")

  pixel_values = processor(image, return_tensors="pt").pixel_values
  generated_ids = model.generate(pixel_values)

  generated_text = processor.batch_decode(generated_ids, skip_special_tokens=True)
  print(json.dumps(generated_text))

if __name__ == "__main__":
    main()

